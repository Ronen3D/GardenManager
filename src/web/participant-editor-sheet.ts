/**
 * Participant Editor Sheet — unified editor for one participant.
 *
 * Replaces the table's inline-edit row, the blackout-expansion row, and the
 * "Add participant" form with a single modal/bottom-sheet.
 *
 * - Desktop: centered card on the standard `gm-modal-backdrop` (max ~640px).
 * - Mobile (≤767px): the same backdrop + dialog renders as a bottom sheet
 *   via the existing `.gm-edit-sheet-v2` mobile CSS rules.
 *
 * Flow:
 *  - Every section (Identity / Skills / Pairings / Unavailability) is edited
 *    into an in-memory draft and committed together on [שמור] as a single
 *    store transaction — one undo step, one schedule reconciliation. A Discard
 *    reverts the whole draft, unavailability blocks included.
 *  - Outside-tap / Esc / drag-down on dirty state shows the existing 3-button
 *    save-confirm dialog.
 */

import { checkTemplateEligibility } from '../engine/validator';
import { type DateUnavailability, Level, type Participant } from '../models/types';
import * as store from './config-store';
import { getEffectivePakalIds } from './pakal-utils';
import { showPeoplePicker } from './people-picker';
import { type RangePickerOption, type RangePickerResult, showRangePicker } from './range-picker-modal';
import { escAttr, escHtml, SVG_ICONS } from './ui-helpers';
import { lockBodyScroll, showConfirm, showSaveConfirm, showToast, unlockBodyScroll } from './ui-modal';

const LEVEL_OPTIONS: Level[] = [Level.L0, Level.L2, Level.L3, Level.L4];
const DEFAULT_WORKLOAD_MULTIPLIER = 1;

const FORBIDDEN_GROUP_PATTERNS = [/^new\s*group$/i, /^group\s*\w$/i, /^untitled/i, /^default/i];

export interface ParticipantEditorOptions {
  mode: 'create' | 'edit';
  /** Required when mode === 'edit'. */
  participantId?: string;
  /** When set, scroll/focus the matching section after open. */
  scrollTo?: 'unavailability';
}

export interface ParticipantEditorResult {
  saved: boolean;
  participantId?: string;
}

let _isOpen = false;

/**
 * Open the participant editor sheet. Resolves once the user saves or
 * dismisses. While open, subsequent calls are no-ops.
 */
export function showParticipantEditor(opts: ParticipantEditorOptions): Promise<ParticipantEditorResult> {
  if (_isOpen) return Promise.resolve({ saved: false });
  _isOpen = true;
  return runEditor(opts).finally(() => {
    _isOpen = false;
  });
}

interface DraftFields {
  name: string;
  group: string;
  newGroupName: string;
  level: Level;
  workloadMultiplier: number;
  certifications: Set<string>;
  pakalIds: Set<string>;
  notWithIds: Set<string>;
  preferredTaskName: string;
  lessPreferredTaskName: string;
  /**
   * Working copy of the participant's unavailability rules. Edited in-memory and
   * committed atomically with the rest of the draft on Save (a Discard reverts
   * these too). New rules added in-session carry a temporary `du-tmp-*` id until
   * they are persisted on Save.
   */
  dateUnavailability: DateUnavailability[];
}

function snapshotParticipant(p: Participant): DraftFields {
  return {
    name: p.name,
    group: p.group,
    newGroupName: '',
    level: p.level,
    workloadMultiplier: p.workloadMultiplier ?? DEFAULT_WORKLOAD_MULTIPLIER,
    certifications: new Set(p.certifications),
    pakalIds: new Set(p.pakalIds || []),
    notWithIds: new Set(store.getNotWithIds(p.id)),
    preferredTaskName: p.preferredTaskName ?? '',
    lessPreferredTaskName: p.lessPreferredTaskName ?? '',
    dateUnavailability: store.getDateUnavailabilities(p.id).map((r) => ({ ...r })),
  };
}

function emptyDraft(): DraftFields {
  const groups = store.getGroups();
  const firstActiveCert = store.getCertificationDefinitions()[0]?.id;
  return {
    name: '',
    group: groups[0] ?? '__new__',
    newGroupName: '',
    level: Level.L0,
    workloadMultiplier: DEFAULT_WORKLOAD_MULTIPLIER,
    certifications: new Set(firstActiveCert ? [firstActiveCert] : []),
    pakalIds: new Set(),
    notWithIds: new Set(),
    preferredTaskName: '',
    lessPreferredTaskName: '',
    dateUnavailability: [],
  };
}

let _tmpRuleCounter = 0;
function tempRuleId(): string {
  return `du-tmp-${++_tmpRuleCounter}`;
}

/** Value-equality for one unavailability rule, ignoring its id. */
function singleRuleEqual(a: DateUnavailability, b: DateUnavailability): boolean {
  return (
    a.dayIndex === b.dayIndex &&
    (a.endDayIndex ?? null) === (b.endDayIndex ?? null) &&
    a.startHour === b.startHour &&
    a.endHour === b.endHour &&
    !!a.allDay === !!b.allDay &&
    (a.reason ?? '') === (b.reason ?? '')
  );
}

/** Positional value-equality for two rule lists (order is stable across edits). */
function rulesEqual(a: DateUnavailability[], b: DateUnavailability[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || !singleRuleEqual(a[i], b[i])) return false;
  }
  return true;
}

function draftsEqual(a: DraftFields, b: DraftFields): boolean {
  if (a.name !== b.name) return false;
  if (a.group !== b.group) return false;
  if (a.newGroupName.trim() !== b.newGroupName.trim()) return false;
  if (a.level !== b.level) return false;
  if (Math.abs(a.workloadMultiplier - b.workloadMultiplier) > 1e-9) return false;
  if (!setsEqual(a.certifications, b.certifications)) return false;
  if (!setsEqual(a.pakalIds, b.pakalIds)) return false;
  if (!setsEqual(a.notWithIds, b.notWithIds)) return false;
  if (a.preferredTaskName !== b.preferredTaskName) return false;
  if (a.lessPreferredTaskName !== b.lessPreferredTaskName) return false;
  if (!rulesEqual(a.dateUnavailability, b.dateUnavailability)) return false;
  return true;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

interface GroupValidation {
  valid: boolean;
  error: string;
}

function validateGroupName(raw: string, existingGroups: string[]): GroupValidation {
  const name = raw.trim();
  if (!name) return { valid: false, error: 'קבוצה לא יכולה להיות ריקה.' };
  if (name.length < 2) return { valid: false, error: 'שם קבוצה חייב להכיל לפחות 2 תווים.' };
  for (const pat of FORBIDDEN_GROUP_PATTERNS) {
    if (pat.test(name)) return { valid: false, error: `"${name}" אינו מותר כשם קבוצה.` };
  }
  const lower = name.toLowerCase();
  const dup = existingGroups.find((g) => g.toLowerCase() === lower && g !== name);
  if (dup) return { valid: false, error: `קבוצה דומה "${dup}" כבר קיימת. השתמש בה.` };
  return { valid: true, error: '' };
}

function parseWorkloadMultiplier(raw: string | undefined): number {
  const v = parseFloat(raw ?? '');
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_WORKLOAD_MULTIPLIER;
  return v;
}

function formatWorkloadMultiplier(m: number): string {
  return Number(m.toFixed(2)).toString();
}

/**
 * Show a directional warning next to the workload-multiplier stepper whenever
 * the value deviates from the neutral default (1). A multiplier > 1 shrinks the
 * participant's effective capacity (fewer assignments); < 1 grows it (more
 * assignments) — see effectiveCapacity() in soft-constraints.ts.
 */
function refreshMultWarning(body: HTMLElement, draft: DraftFields): void {
  const warnEl = body.querySelector('[data-pe-mult-warning]') as HTMLElement | null;
  if (!warnEl) return;
  const textEl = warnEl.querySelector('.warn-text') as HTMLElement | null;
  const m = draft.workloadMultiplier;
  if (m > DEFAULT_WORKLOAD_MULTIPLIER + 1e-9) {
    if (textEl) textEl.textContent = 'ערך מעל 1 מקטין את העומס על המשתתף';
    warnEl.classList.remove('hidden');
  } else if (m < DEFAULT_WORKLOAD_MULTIPLIER - 1e-9) {
    if (textEl) textEl.textContent = 'ערך מתחת ל-1 מעלה את העומס על המשתתף';
    warnEl.classList.remove('hidden');
  } else {
    warnEl.classList.add('hidden');
  }
}

async function runEditor(opts: ParticipantEditorOptions): Promise<ParticipantEditorResult> {
  return new Promise((resolve) => {
    const isCreate = opts.mode === 'create';
    const participant: Participant | undefined = isCreate
      ? undefined
      : opts.participantId
        ? store.getParticipant(opts.participantId)
        : undefined;

    if (!isCreate && !participant) {
      resolve({ saved: false });
      return;
    }

    const original: DraftFields = participant ? snapshotParticipant(participant) : emptyDraft();
    const draft: DraftFields = participant ? snapshotParticipant(participant) : emptyDraft();
    const participantId: string | undefined = participant?.id;

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = renderShell(isCreate, draft);
    document.body.appendChild(backdrop);
    lockBodyScroll();

    const bodyEl = backdrop.querySelector('[data-pe-body]') as HTMLElement;
    const saveBtn = backdrop.querySelector('[data-pe-save]') as HTMLButtonElement;
    const cancelBtn = backdrop.querySelector('[data-pe-cancel]') as HTMLButtonElement;
    const closeBtn = backdrop.querySelector('[data-pe-close]') as HTMLButtonElement;

    const closed = { value: false };

    const close = (result: ParticipantEditorResult) => {
      if (closed.value) return;
      closed.value = true;
      backdrop.remove();
      unlockBodyScroll();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };

    const isDirty = (): boolean => !draftsEqual(draft, original);

    const renderUnavailabilitySectionInto = (host: HTMLElement) => {
      host.innerHTML = renderUnavailabilitySection(draft.dateUnavailability);
      wireUnavailabilitySection(host, draft, () => renderUnavailabilitySectionInto(host));
    };

    // Initial unavailability render — draft-based, available in both create and edit modes.
    const unavailHost = bodyEl.querySelector('[data-pe-unavail-host]') as HTMLElement | null;
    if (unavailHost) renderUnavailabilitySectionInto(unavailHost);

    // Wire identity / skills / pairings — all draft-only updates.
    wireIdentitySection(bodyEl, draft);
    wireSkillsSection(bodyEl, draft, participantId);
    wirePairingsSection(bodyEl, draft, participantId);

    // Initial preference-eligibility check (renders any warning text).
    refreshEligibilityWarnings(bodyEl, draft);

    const onSaveClick = async () => {
      const ok = await commitDraft(draft, participantId, bodyEl);
      if (!ok) return;
      close({ saved: true, participantId: ok.participantId });
    };
    saveBtn.addEventListener('click', onSaveClick);

    // Cancel / X / Esc / backdrop tap → save-confirm if dirty.
    // All sections (including unavailability) live in the draft and commit
    // together on Save, so the dirty check covers block edits too and a
    // Discard reverts them.
    const dismiss = async () => {
      if (closed.value) return;
      if (!isDirty()) {
        close({ saved: false, participantId });
        return;
      }
      const result = await showSaveConfirm();
      if (result === 'save') {
        const ok = await commitDraft(draft, participantId, bodyEl);
        if (ok) close({ saved: true, participantId: ok.participantId });
      } else if (result === 'discard') {
        close({ saved: false, participantId });
      }
      // 'continue' → keep open
    };

    cancelBtn.addEventListener('click', dismiss);
    closeBtn.addEventListener('click', dismiss);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) dismiss();
    });

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    }
    document.addEventListener('keydown', onKey);

    // Optional scroll-to-section
    if (opts.scrollTo === 'unavailability') {
      requestAnimationFrame(() => {
        const target = bodyEl.querySelector('[data-pe-section="unavailability"]') as HTMLElement | null;
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    // Focus the name input on open
    requestAnimationFrame(() => {
      const nameInput = bodyEl.querySelector('[data-pe-field="name"]') as HTMLInputElement | null;
      nameInput?.focus();
      if (isCreate) nameInput?.select();
    });
  });
}

// ───────────────────────────── Rendering ─────────────────────────────

function renderShell(isCreate: boolean, draft: DraftFields): string {
  const title = isCreate ? 'הוספת משתתף' : 'עריכת משתתף';
  const saveLabel = isCreate ? 'הוסף' : 'שמור';
  return `
    <div class="gm-modal-dialog gm-modal-dialog-wide gm-edit-sheet-v2" role="dialog" aria-modal="true" aria-labelledby="pe-title">
      <div class="pe-header">
        <button class="pe-close" data-pe-close type="button" aria-label="סגור">✕</button>
        <span class="pe-title" id="pe-title">${escHtml(title)}</span>
      </div>
      <div class="pe-body" data-pe-body>
        ${renderIdentitySection(draft)}
        ${renderSkillsSection(draft)}
        ${renderPairingsSection(draft)}
        <div class="pe-section" data-pe-section="unavailability" data-pe-unavail-host></div>
      </div>
      <div class="pe-footer">
        <button class="btn-sm btn-outline" data-pe-cancel type="button">ביטול</button>
        <button class="btn-primary btn-sm pe-save" data-pe-save type="button">${escHtml(saveLabel)}</button>
      </div>
    </div>`;
}

function renderIdentitySection(draft: DraftFields): string {
  const groups = store.getGroups();
  const groupOptions = groups
    .map((g) => `<option value="${escAttr(g)}" ${g === draft.group ? 'selected' : ''}>${escHtml(g)}</option>`)
    .join('');
  const isNewGroup = draft.group === '__new__' || (groups.length === 0 && !groups.includes(draft.group));
  return `
    <div class="pe-section" data-pe-section="identity">
      <div class="pe-section-title">זהות</div>
      <div class="pe-field">
        <label class="pe-field-label" for="pe-name">שם</label>
        <input id="pe-name" class="input-sm pe-input" data-pe-field="name" type="text"
               value="${escAttr(draft.name)}" maxlength="${store.MAX_PARTICIPANT_NAME_LENGTH}"
               placeholder="שם המשתתף" autocomplete="off" />
      </div>
      <div class="pe-field">
        <label class="pe-field-label" for="pe-group">קבוצה</label>
        <div class="pe-group-row">
          <select id="pe-group" class="input-sm pe-input" data-pe-field="group">
            ${groupOptions}
            <option value="__new__" ${isNewGroup ? 'selected' : ''}>+ קבוצה חדשה…</option>
          </select>
          <input class="input-sm pe-input pe-new-group-input ${isNewGroup ? '' : 'hidden'}"
                 data-pe-field="new-group-name" type="text" placeholder="הכנס שם קבוצה"
                 value="${escAttr(draft.newGroupName)}" maxlength="40" />
        </div>
        <span class="pe-field-error pe-group-error hidden"></span>
        <span class="pe-field-help pe-group-info hidden"></span>
      </div>
      <div class="pe-field">
        <span class="pe-field-label">דרגה</span>
        <div class="pe-level-chips" role="radiogroup" aria-label="דרגה">
          ${LEVEL_OPTIONS.map(
            (
              l,
            ) => `<button type="button" class="pe-level-chip pe-level-chip--l${l} ${draft.level === l ? 'pe-level-chip--active' : ''}"
                       role="radio" aria-checked="${draft.level === l ? 'true' : 'false'}"
                       data-pe-level="${l}">L${l}</button>`,
          ).join('')}
        </div>
      </div>
      <div class="pe-field pe-field-mult">
        <label class="pe-field-label" for="pe-mult">מקדם עומס</label>
        <div class="pe-mult-row">
          <button type="button" class="pe-mult-step" data-pe-mult-step="-1" aria-label="הקטן">−</button>
          <input id="pe-mult" class="input-sm pe-input pe-mult-input" type="number" step="0.1" min="0.1"
                 data-pe-field="workloadMultiplier" value="${escAttr(formatWorkloadMultiplier(draft.workloadMultiplier))}" />
          <button type="button" class="pe-mult-step" data-pe-mult-step="1" aria-label="הגדל">+</button>
          <span class="pe-mult-help" title="ערך &gt; 1 מקטין את ההקצאות, ערך &lt; 1 מגדיל אותן.">ⓘ</span>
          <span class="pe-mult-warning hidden" data-pe-mult-warning role="status" aria-live="polite">
            <span class="warn-icon" aria-hidden="true">⚠</span><span class="warn-text"></span>
          </span>
        </div>
      </div>
    </div>`;
}

function renderSkillsSection(draft: DraftFields): string {
  const certDefs = store.getCertificationDefinitions();
  const pakalDefs = store.getPakalDefinitions();
  const taskNames = [...new Set(store.getAllTaskTemplates().map((t) => t.name))];

  // Active cert checkboxes
  let certHtml = certDefs
    .map(
      (def) => `<label class="pe-checkbox">
        <input type="checkbox" data-pe-cert="${escAttr(def.id)}" ${draft.certifications.has(def.id) ? 'checked' : ''} />
        <span>${escHtml(def.label)}</span>
      </label>`,
    )
    .join('');
  // Orphan certs (deleted definitions) — rendered with warning so user can decide to keep or remove
  const activeCertIds = new Set(certDefs.map((d) => d.id));
  for (const c of draft.certifications) {
    if (activeCertIds.has(c)) continue;
    const tomb = store.getCertificationById(c);
    const label = tomb?.label ?? c;
    certHtml += `<label class="pe-checkbox pe-checkbox--orphan">
      <input type="checkbox" data-pe-cert="${escAttr(c)}" checked />
      <span>⚠ ${escHtml(label)}</span>
    </label>`;
  }

  const effectiveSet = new Set(
    getEffectivePakalIds(
      {
        id: '',
        name: '',
        level: Level.L0,
        certifications: [...draft.certifications],
        group: '',
        availability: [],
        dateUnavailability: [],
        pakalIds: [...draft.pakalIds],
      },
      pakalDefs,
    ),
  );
  const pakalHtml = pakalDefs
    .map(
      (def) => `<label class="pe-checkbox">
        <input type="checkbox" data-pe-pakal="${escAttr(def.id)}" ${effectiveSet.has(def.id) ? 'checked' : ''} />
        <span>${escHtml(def.label)}</span>
      </label>`,
    )
    .join('');

  const taskOptions = (selected: string) =>
    `<option value="">— ללא —</option>` +
    taskNames
      .map((n) => `<option value="${escAttr(n)}" ${n === selected ? 'selected' : ''}>${escHtml(n)}</option>`)
      .join('');

  return `
    <div class="pe-section">
      <div class="pe-section-title">הסמכות ופק"לים</div>
      <div class="pe-field">
        <span class="pe-field-label">הסמכות</span>
        <div class="pe-checkboxes" data-pe-cert-list>${certHtml}</div>
      </div>
      <div class="pe-field">
        <span class="pe-field-label">פק"לים</span>
        <div class="pe-checkboxes" data-pe-pakal-list>${pakalHtml}</div>
      </div>
      <div class="pe-field">
        <label class="pe-field-label" for="pe-pref">משימה מועדפת</label>
        <select id="pe-pref" class="input-sm pe-input" data-pe-field="preferredTaskName">
          ${taskOptions(draft.preferredTaskName)}
        </select>
        <div class="pe-field-warning hidden" data-pe-pref-warning="preferredTaskName">
          <span class="warn-icon">⚠</span><span class="warn-text"></span>
        </div>
      </div>
      <div class="pe-field">
        <label class="pe-field-label" for="pe-less">משימה פחות מועדפת</label>
        <select id="pe-less" class="input-sm pe-input" data-pe-field="lessPreferredTaskName">
          ${taskOptions(draft.lessPreferredTaskName)}
        </select>
        <div class="pe-field-warning hidden" data-pe-pref-warning="lessPreferredTaskName">
          <span class="warn-icon">⚠</span><span class="warn-text"></span>
        </div>
      </div>
    </div>`;
}

function renderPairingsSection(draft: Pick<DraftFields, 'notWithIds'>): string {
  const candidates = store.getAllParticipants();
  return `
    <div class="pe-section">
      <div class="pe-section-title">אי התאמה</div>
      <div class="pe-field">
        <span class="pe-field-label">אי התאמה עם</span>
        <div class="pe-notwith" data-pe-notwith>
          ${renderNotWithChips(draft.notWithIds, candidates)}
        </div>
        <button type="button" class="btn-sm btn-outline pe-notwith-open" data-pe-notwith-open>+ הוסף / ערוך…</button>
        <div class="pe-field-help">לחיצה על × תסיר את החיבור.</div>
      </div>
    </div>`;
}

function renderNotWithChips(selected: Set<string>, candidates: Participant[]): string {
  if (selected.size === 0) {
    return `<div class="pe-notwith-chips" data-pe-notwith-chips><span class="pe-notwith-empty">— אין חיבורים —</span></div>`;
  }
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const chips = [...selected]
    .map((id) => {
      const p = byId.get(id);
      if (!p) return '';
      return `<span class="pe-notwith-chip">
        <span>${escHtml(p.name)}</span>
        <button type="button" class="pe-notwith-remove" data-pe-notwith-remove="${escAttr(id)}" aria-label="הסר ${escAttr(p.name)}">×</button>
      </span>`;
    })
    .filter(Boolean)
    .join('');
  return `<div class="pe-notwith-chips" data-pe-notwith-chips>${chips}</div>`;
}

function renderUnavailabilitySection(rules: DateUnavailability[]): string {
  let cards = '';
  if (rules.length === 0) {
    cards = `<div class="pe-unavail-empty">לא הוגדרו חסימות. הוסף חוקי חסימה לימים ספציפיים בשבצ"ק.</div>`;
  } else {
    cards = rules.map(renderUnavailabilityCard).join('');
  }

  return `
    <div class="pe-section-title">אי זמינות קבועה</div>
    <div class="pe-unavail-list" data-pe-unavail-list>${cards}</div>
    <div class="pe-unavail-actions">
      <button type="button" class="btn-sm btn-primary pe-unavail-add" data-pe-unavail-add>+ הוסף חסימה</button>
    </div>
  `;
}

function renderUnavailabilityCard(r: DateUnavailability): string {
  const dayLabel =
    r.endDayIndex && r.endDayIndex !== r.dayIndex ? `יום ${r.dayIndex} → יום ${r.endDayIndex}` : `יום ${r.dayIndex}`;
  const timeLabel = r.allDay
    ? '<span class="pe-unavail-allday">כל היום</span>'
    : `<span class="pe-unavail-time" dir="ltr">${String(r.startHour).padStart(2, '0')}:00 – ${String(r.endHour).padStart(2, '0')}:00</span>`;
  const reason = r.reason ? `<div class="pe-unavail-reason">${escHtml(r.reason)}</div>` : '';
  return `<div class="pe-unavail-card" data-pe-unavail-card="${escAttr(r.id)}">
    <div class="pe-unavail-card-main">
      <div class="pe-unavail-card-row">
        <span class="pe-unavail-day">${escHtml(dayLabel)}</span>
        <span class="pe-unavail-sep">·</span>
        ${timeLabel}
      </div>
      ${reason}
    </div>
    <div class="pe-unavail-card-actions">
      <button class="btn-sm btn-outline btn-icon" type="button" data-pe-unavail-edit="${escAttr(r.id)}" aria-label="ערוך">${SVG_ICONS.edit}</button>
      <button class="btn-sm btn-outline btn-danger-outline btn-icon" type="button" data-pe-unavail-delete="${escAttr(r.id)}" aria-label="מחק">${SVG_ICONS.trash}</button>
    </div>
  </div>`;
}

// ───────────────────────────── Wiring ─────────────────────────────

function wireIdentitySection(body: HTMLElement, draft: DraftFields): void {
  // Name
  const nameInput = body.querySelector('[data-pe-field="name"]') as HTMLInputElement;
  nameInput.addEventListener('input', () => {
    draft.name = nameInput.value;
  });

  // Group
  const groupSelect = body.querySelector('[data-pe-field="group"]') as HTMLSelectElement;
  const newGroupInput = body.querySelector('[data-pe-field="new-group-name"]') as HTMLInputElement;
  const groupError = body.querySelector('.pe-group-error') as HTMLElement;
  const groupInfo = body.querySelector('.pe-group-info') as HTMLElement;
  groupSelect.addEventListener('change', () => {
    draft.group = groupSelect.value;
    if (groupSelect.value === '__new__') {
      newGroupInput.classList.remove('hidden');
      newGroupInput.focus();
    } else {
      newGroupInput.classList.add('hidden');
      newGroupInput.value = '';
      draft.newGroupName = '';
      groupError.classList.add('hidden');
      groupInfo.classList.add('hidden');
      newGroupInput.removeAttribute('aria-invalid');
    }
  });
  newGroupInput.addEventListener('input', () => {
    draft.newGroupName = newGroupInput.value;
    const trimmed = newGroupInput.value.trim();
    if (!trimmed) {
      groupError.classList.add('hidden');
      groupInfo.classList.add('hidden');
      newGroupInput.removeAttribute('aria-invalid');
    } else {
      const v = validateGroupName(newGroupInput.value, store.getGroups());
      if (v.valid) {
        groupError.classList.add('hidden');
        newGroupInput.removeAttribute('aria-invalid');
        const existing = store.getGroups().find((g) => g.toLowerCase() === trimmed.toLowerCase());
        if (existing) {
          groupInfo.textContent = `קבוצה "${existing}" כבר קיימת — המשתתף/ת יצורף/תצורף אליה, ולא תיווצר קבוצה חדשה.`;
          groupInfo.classList.remove('hidden');
        } else {
          groupInfo.classList.add('hidden');
        }
      } else {
        groupError.textContent = v.error;
        groupError.classList.remove('hidden');
        groupInfo.classList.add('hidden');
        newGroupInput.setAttribute('aria-invalid', 'true');
      }
    }
  });

  // Level chips
  body.querySelectorAll<HTMLButtonElement>('[data-pe-level]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const lvl = parseInt(chip.dataset.peLevel || '0', 10) as Level;
      draft.level = lvl;
      body.querySelectorAll<HTMLButtonElement>('[data-pe-level]').forEach((c) => {
        const active = parseInt(c.dataset.peLevel || '0', 10) === lvl;
        c.classList.toggle('pe-level-chip--active', active);
        c.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      refreshEligibilityWarnings(body, draft);
    });
  });

  // Workload multiplier
  const multInput = body.querySelector('[data-pe-field="workloadMultiplier"]') as HTMLInputElement;
  multInput.addEventListener('input', () => {
    draft.workloadMultiplier = parseWorkloadMultiplier(multInput.value);
    refreshMultWarning(body, draft);
  });
  body.querySelectorAll<HTMLButtonElement>('[data-pe-mult-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = parseInt(btn.dataset.peMultStep || '0', 10);
      const next = Math.max(0.1, +(draft.workloadMultiplier + 0.1 * step).toFixed(2));
      draft.workloadMultiplier = next;
      multInput.value = formatWorkloadMultiplier(next);
      refreshMultWarning(body, draft);
    });
  });
  refreshMultWarning(body, draft);
}

function wireSkillsSection(body: HTMLElement, draft: DraftFields, _participantId: string | undefined): void {
  // Certifications
  body.querySelectorAll<HTMLInputElement>('[data-pe-cert]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.peCert!;
      if (cb.checked) draft.certifications.add(id);
      else draft.certifications.delete(id);
      refreshEligibilityWarnings(body, draft);
    });
  });

  // Pakals
  body.querySelectorAll<HTMLInputElement>('[data-pe-pakal]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.pePakal!;
      if (cb.checked) draft.pakalIds.add(id);
      else draft.pakalIds.delete(id);
    });
  });

  // Preferences
  const prefSel = body.querySelector('[data-pe-field="preferredTaskName"]') as HTMLSelectElement;
  prefSel.addEventListener('change', () => {
    draft.preferredTaskName = prefSel.value;
    refreshEligibilityWarnings(body, draft);
  });
  const lessSel = body.querySelector('[data-pe-field="lessPreferredTaskName"]') as HTMLSelectElement;
  lessSel.addEventListener('change', () => {
    draft.lessPreferredTaskName = lessSel.value;
    refreshEligibilityWarnings(body, draft);
  });
}

function wirePairingsSection(
  body: HTMLElement,
  draft: Pick<DraftFields, 'notWithIds'>,
  participantId: string | undefined,
): void {
  const host = body.querySelector('[data-pe-notwith]') as HTMLElement;

  // Re-render only the chips host (the "+ הוסף / ערוך…" trigger lives outside it
  // and is wired once below).
  const rerenderChips = () => {
    host.innerHTML = renderNotWithChips(draft.notWithIds, store.getAllParticipants());
    wireRemoveButtons();
  };

  const wireRemoveButtons = () => {
    host.querySelectorAll<HTMLButtonElement>('[data-pe-notwith-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.peNotwithRemove!;
        draft.notWithIds.delete(id);
        rerenderChips();
      });
    });
  };
  wireRemoveButtons();

  // Open the searchable multi-select picker. It returns a NEW set on אישור, so
  // several partners can be chosen in one pass; null ⇒ cancelled (draft kept).
  body.querySelector('[data-pe-notwith-open]')?.addEventListener('click', async () => {
    const result = await showPeoplePicker({
      title: 'אי התאמה עם',
      candidates: store.getAllParticipants(),
      selected: new Set(draft.notWithIds),
      excludeId: participantId,
      emptyHint: 'אין משתתפים נוספים להוספה.',
    });
    if (result) {
      draft.notWithIds = result;
      rerenderChips();
    }
  });
}

function wireUnavailabilitySection(
  host: HTMLElement,
  draft: Pick<DraftFields, 'dateUnavailability'>,
  rerender: () => void,
): void {
  // Add new — pushes a draft rule with a temporary id (persisted on Save).
  host.querySelector('[data-pe-unavail-add]')?.addEventListener('click', async () => {
    const result = await openUnavailPicker();
    if (!result) return;
    const rule = mapPickerResultToRule(result);
    if (!rule) return;
    draft.dateUnavailability.push({ ...rule, id: tempRuleId() });
    rerender();
  });

  // Edit existing — replaces the draft rule in place, preserving its id + order.
  host.querySelectorAll<HTMLButtonElement>('[data-pe-unavail-edit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.peUnavailEdit!;
      const idx = draft.dateUnavailability.findIndex((r) => r.id === id);
      if (idx < 0) return;
      const result = await openUnavailPicker(draft.dateUnavailability[idx]);
      if (!result) return;
      const next = mapPickerResultToRule(result);
      if (!next) return;
      draft.dateUnavailability[idx] = { ...next, id };
      rerender();
    });
  });

  // Delete existing — removes the rule from the draft array.
  host.querySelectorAll<HTMLButtonElement>('[data-pe-unavail-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.peUnavailDelete!;
      const ok = await showConfirm('להסיר את כלל החסימה?', {
        danger: true,
        title: 'הסרת חסימה',
        confirmLabel: 'הסר',
      });
      if (!ok) return;
      const idx = draft.dateUnavailability.findIndex((r) => r.id === id);
      if (idx >= 0) draft.dateUnavailability.splice(idx, 1);
      rerender();
    });
  });
}

async function openUnavailPicker(existing?: DateUnavailability): Promise<RangePickerResult | null> {
  const nDays = store.getScheduleDays();
  const days: RangePickerOption[] = Array.from({ length: nDays }, (_, i) => ({
    value: String(i + 1),
    label: `יום ${i + 1}`,
  }));
  const hours: RangePickerOption[] = Array.from({ length: 24 }, (_, i) => ({
    value: String(i),
    label: `${String(i).padStart(2, '0')}:00`,
  }));
  const dayStartHour = store.getDayStartHour();

  const defaultStartDay = existing ? String(existing.dayIndex) : '1';
  const defaultEndDay = existing ? String(existing.endDayIndex ?? existing.dayIndex) : defaultStartDay;
  const defaultStartHour = existing ? String(existing.startHour) : '8';
  const defaultEndHour = existing ? String(existing.endHour) : '12';
  const defaultReason = existing?.reason;
  const defaultAllDay = existing?.allDay ?? false;

  return showRangePicker({
    title: existing ? 'עריכת חסימה' : 'הוספת חסימה',
    iconOverride: '🚫',
    days,
    hours,
    defaultStartDay,
    defaultStartHour,
    defaultEndDay,
    defaultEndHour,
    defaultReason,
    allowAllDay: true,
    defaultAllDay,
    dayStartHour,
    validate: (v) => {
      const ds = parseInt(v.startDay, 10);
      const de = parseInt(v.endDay, 10);
      if (de < ds) return 'יום סיום חייב להיות גדול או שווה ליום ההתחלה.';
      if (!v.allDay) {
        const sh = parseInt(v.startHour, 10);
        const eh = parseInt(v.endHour, 10);
        if (ds === de && sh === eh) {
          return 'שעת התחלה ושעת סיום לא יכולות להיות זהות באותו יום. סמן "כל היום" אם זו הכוונה.';
        }
      }
      return null;
    },
    onPreview: (v) => {
      const ds = parseInt(v.startDay, 10);
      const de = parseInt(v.endDay, 10);
      const dayLabel = ds === de ? `יום ${ds}` : `יום ${ds} → יום ${de}`;
      if (v.allDay) return `${dayLabel} · כל היום`;
      const sh = parseInt(v.startHour, 10);
      const eh = parseInt(v.endHour, 10);
      const span = de - ds;
      const hours = span === 0 ? Math.abs(eh - sh) : 24 * span - sh + eh;
      const hoursLabel = hours > 0 ? ` · ${hours} שעות חסימה` : '';
      return `${dayLabel} · ${String(sh).padStart(2, '0')}:00–${String(eh).padStart(2, '0')}:00${hoursLabel}`;
    },
  });
}

function mapPickerResultToRule(result: RangePickerResult): Omit<DateUnavailability, 'id'> | null {
  const ds = parseInt(result.startDay, 10);
  const de = parseInt(result.endDay, 10);
  if (!Number.isFinite(ds) || !Number.isFinite(de)) return null;
  const sh = parseInt(result.startHour, 10);
  const eh = parseInt(result.endHour, 10);
  return {
    dayIndex: ds,
    ...(de > ds ? { endDayIndex: de } : {}),
    allDay: result.allDay,
    startHour: result.allDay ? 0 : sh,
    endHour: result.allDay ? 24 : eh,
    reason: result.reason,
  };
}

// ───────────────────────────── Eligibility ─────────────────────────────

function refreshEligibilityWarnings(body: HTMLElement, draft: DraftFields): void {
  refreshOnePrefWarning(body, 'preferredTaskName', draft.preferredTaskName, draft);
  refreshOnePrefWarning(body, 'lessPreferredTaskName', draft.lessPreferredTaskName, draft);
}

function refreshOnePrefWarning(body: HTMLElement, field: string, taskName: string, draft: DraftFields): void {
  const warnEl = body.querySelector(`[data-pe-pref-warning="${field}"]`) as HTMLElement | null;
  if (!warnEl) return;
  if (!taskName) {
    warnEl.classList.add('hidden');
    return;
  }
  const templates = store.getAllTaskTemplates().filter((t) => t.name === taskName);
  if (templates.length === 0) {
    warnEl.classList.add('hidden');
    return;
  }
  let bestReasons: string[] = [];
  let eligible = false;
  for (const tpl of templates) {
    const result = checkTemplateEligibility(draft.level, [...draft.certifications], tpl, store.getCertLabel);
    if (result.eligible) {
      eligible = true;
      break;
    }
    if (bestReasons.length === 0) bestReasons = result.reasons;
  }
  if (eligible) {
    warnEl.classList.add('hidden');
  } else {
    const text = warnEl.querySelector('.warn-text') as HTMLElement;
    text.textContent = bestReasons.join(' | ');
    warnEl.classList.remove('hidden');
  }
}

// ───────────────────────────── Commit ─────────────────────────────

interface CommitOk {
  participantId: string;
}

/** Reconcile a participant's not-with set to `desired` (symmetric add/remove). */
function commitNotWithDiff(pid: string, desired: Set<string>): void {
  const current = new Set(store.getNotWithIds(pid));
  for (const id of current) if (!desired.has(id)) store.removeNotWith(pid, id);
  for (const id of desired) if (!current.has(id)) store.addNotWith(pid, id);
}

/**
 * Reconcile a participant's unavailability rules to `desired`, diffing against
 * what the store currently holds: rules dropped from the draft are removed,
 * draft rules whose id isn't in the store are added (temp ids get a fresh real
 * id on persist), and rules whose values changed are updated in place (id and
 * list position preserved). Intended to run inside a `store.transaction(...)`.
 */
function commitUnavailabilityDiff(pid: string, desired: DateUnavailability[]): void {
  // Copy the live array — removeDateUnavailability splices it as we iterate.
  const storeRules = [...store.getDateUnavailabilities(pid)];
  const storeById = new Map(storeRules.map((r) => [r.id, r]));
  const desiredIds = new Set(desired.map((r) => r.id));
  for (const r of storeRules) if (!desiredIds.has(r.id)) store.removeDateUnavailability(pid, r.id);
  for (const r of desired) {
    const { id, ...rule } = r;
    const existing = storeById.get(id);
    if (!existing) store.addDateUnavailability(pid, rule);
    else if (!singleRuleEqual(existing, r)) store.updateDateUnavailability(pid, id, rule);
  }
}

async function commitDraft(
  draft: DraftFields,
  participantId: string | undefined,
  body: HTMLElement,
): Promise<CommitOk | null> {
  const name = draft.name.trim();
  if (!name) {
    showToast('יש להזין שם משתתף/ת', { type: 'error' });
    (body.querySelector('[data-pe-field="name"]') as HTMLInputElement | null)?.focus();
    return null;
  }
  if (store.isParticipantNameTaken(name, participantId)) {
    showToast('משתתף/ת בשם זה כבר קיים/ת', { type: 'error' });
    (body.querySelector('[data-pe-field="name"]') as HTMLInputElement | null)?.focus();
    return null;
  }
  let group = draft.group;
  if (group === '__new__') {
    const v = validateGroupName(draft.newGroupName, store.getGroups());
    if (!v.valid) {
      const err = body.querySelector('.pe-group-error') as HTMLElement;
      err.textContent = v.error;
      err.classList.remove('hidden');
      (body.querySelector('[data-pe-field="new-group-name"]') as HTMLInputElement | null)?.focus();
      return null;
    }
    const existing = store.getGroups().find((g) => g.toLowerCase() === draft.newGroupName.trim().toLowerCase());
    group = existing ?? draft.newGroupName.trim();
  }

  if (
    draft.preferredTaskName &&
    draft.lessPreferredTaskName &&
    draft.preferredTaskName === draft.lessPreferredTaskName
  ) {
    showToast('משימה מועדפת ומשימה פחות מועדפת לא יכולות להיות זהות', { type: 'error' });
    return null;
  }

  // Commit every field of the participant in ONE store transaction: a single
  // undo snapshot + a single notify() (one schedule reconciliation) for the
  // whole Save, instead of one per field. Validation above already ran, so the
  // body only mutates.
  const pid = store.transaction((): string => {
    let id: string;
    if (!participantId) {
      const newP = store.addParticipant({
        name,
        level: draft.level,
        certifications: [...draft.certifications],
        pakalIds: [...draft.pakalIds],
        group,
        workloadMultiplier: draft.workloadMultiplier,
      });
      id = newP.id;
    } else {
      id = participantId;
      store.updateParticipant(id, {
        name,
        level: draft.level,
        certifications: [...draft.certifications],
        pakalIds: [...draft.pakalIds],
        group,
        workloadMultiplier: draft.workloadMultiplier,
      });
    }
    // setTaskNamePreference has a no-op guard, so calling it unconditionally is
    // safe for a brand-new participant (defaults already undefined).
    store.setTaskNamePreference(id, draft.preferredTaskName || undefined, draft.lessPreferredTaskName || undefined);
    commitNotWithDiff(id, draft.notWithIds);
    commitUnavailabilityDiff(id, draft.dateUnavailability);
    return id;
  });

  if (!participantId) showToast(`${name} נוסף/ה`, { type: 'success' });
  return { participantId: pid };
}

// ──────────────── Focused pairings + availability sheet ────────────────
//
// A slim sheet that edits ONLY a participant's not-with pairings and
// unavailability — the two dimensions the batch table editor can't reach.
// Opened from a table-editor row's "עוד…" button. It reuses the same section
// renderers + the same draft/transaction commit model as the full editor, and
// it is conflict-free with an active table-edit draft: not-with re-syncs from
// the authoritative pairs map and unavailability lives in a separate store map,
// neither of which bulkMutateParticipants overwrites.

interface PairingsAvailabilityDraft {
  notWithIds: Set<string>;
  dateUnavailability: DateUnavailability[];
}

function snapshotPairingsAvailability(p: Participant): PairingsAvailabilityDraft {
  return {
    notWithIds: new Set(store.getNotWithIds(p.id)),
    dateUnavailability: store.getDateUnavailabilities(p.id).map((r) => ({ ...r })),
  };
}

function pairingsAvailabilityEqual(a: PairingsAvailabilityDraft, b: PairingsAvailabilityDraft): boolean {
  return setsEqual(a.notWithIds, b.notWithIds) && rulesEqual(a.dateUnavailability, b.dateUnavailability);
}

/**
 * Open the focused pairings + availability sheet for one existing participant.
 * Resolves `{ saved: true }` only when changes were committed. Shares the
 * full editor's `_isOpen` guard, so it never stacks with the full editor.
 */
export function showPairingsAvailabilitySheet(participantId: string): Promise<{ saved: boolean }> {
  if (_isOpen) return Promise.resolve({ saved: false });
  const participant = store.getParticipant(participantId);
  if (!participant) return Promise.resolve({ saved: false });
  _isOpen = true;
  return runPairingsAvailability(participant).finally(() => {
    _isOpen = false;
  });
}

function runPairingsAvailability(participant: Participant): Promise<{ saved: boolean }> {
  return new Promise((resolve) => {
    const pid = participant.id;
    const original = snapshotPairingsAvailability(participant);
    const draft = snapshotPairingsAvailability(participant);

    const backdrop = document.createElement('div');
    backdrop.className = 'gm-modal-backdrop';
    backdrop.innerHTML = `
      <div class="gm-modal-dialog gm-modal-dialog-wide gm-edit-sheet-v2" role="dialog" aria-modal="true" aria-labelledby="pa-title">
        <div class="pe-header">
          <button class="pe-close" data-pa-close type="button" aria-label="סגור">✕</button>
          <span class="pe-title" id="pa-title">${escHtml(participant.name)} · אי התאמה וזמינות</span>
        </div>
        <div class="pe-body" data-pa-body>
          ${renderPairingsSection(draft)}
          <div class="pe-section" data-pe-section="unavailability" data-pa-unavail-host></div>
        </div>
        <div class="pe-footer">
          <button class="btn-sm btn-outline" data-pa-cancel type="button">ביטול</button>
          <button class="btn-primary btn-sm pe-save" data-pa-save type="button">שמור</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    lockBodyScroll();

    const bodyEl = backdrop.querySelector('[data-pa-body]') as HTMLElement;
    const closed = { value: false };
    const close = (saved: boolean) => {
      if (closed.value) return;
      closed.value = true;
      backdrop.remove();
      unlockBodyScroll();
      document.removeEventListener('keydown', onKey);
      resolve({ saved });
    };

    wirePairingsSection(bodyEl, draft, pid);
    const unavailHost = bodyEl.querySelector('[data-pa-unavail-host]') as HTMLElement | null;
    const renderUnavail = (host: HTMLElement) => {
      host.innerHTML = renderUnavailabilitySection(draft.dateUnavailability);
      wireUnavailabilitySection(host, draft, () => renderUnavail(host));
    };
    if (unavailHost) renderUnavail(unavailHost);

    // Commit both dimensions in one transaction (one undo step, one reconcile).
    const commit = () => {
      store.transaction(() => {
        commitNotWithDiff(pid, draft.notWithIds);
        commitUnavailabilityDiff(pid, draft.dateUnavailability);
      });
    };

    backdrop.querySelector('[data-pa-save]')?.addEventListener('click', () => {
      const dirty = !pairingsAvailabilityEqual(draft, original);
      if (dirty) commit();
      close(dirty);
    });

    const dismiss = async () => {
      if (closed.value) return;
      if (pairingsAvailabilityEqual(draft, original)) {
        close(false);
        return;
      }
      const result = await showSaveConfirm();
      if (result === 'save') {
        commit();
        close(true);
      } else if (result === 'discard') {
        close(false);
      }
      // 'continue' → keep open
    };

    backdrop.querySelector('[data-pa-cancel]')?.addEventListener('click', dismiss);
    backdrop.querySelector('[data-pa-close]')?.addEventListener('click', dismiss);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) dismiss();
    });

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    }
    document.addEventListener('keydown', onKey);
  });
}
