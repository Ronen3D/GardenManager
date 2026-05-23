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
 *  - Identity / Skills / Pairings sections read & write live store state on
 *    [שמור]. Unavailability cards add/edit/delete are committed immediately
 *    (each rule is its own undo step), matching today's behavior.
 *  - Dirty fields show a small dot on Save; outside-tap / Esc / drag-down
 *    on dirty state shows the existing 3-button save-confirm dialog.
 */

import { checkTemplateEligibility } from '../engine/validator';
import { type DateUnavailability, Level, type Participant } from '../models/types';
import * as store from './config-store';
import { getEffectivePakalIds } from './pakal-utils';
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
  };
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
      if (!participantId) return;
      host.innerHTML = renderUnavailabilitySection(participantId);
      wireUnavailabilitySection(host, participantId, () => renderUnavailabilitySectionInto(host));
    };

    // Initial unavailability render (edit mode only)
    if (participantId) {
      const unavailHost = bodyEl.querySelector('[data-pe-unavail-host]') as HTMLElement | null;
      if (unavailHost) renderUnavailabilitySectionInto(unavailHost);
    }

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
    // Unavailability rule changes are committed live (each rule is its own
    // undo step) and are not included in the dirty flag.
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
        ${isCreate ? '' : `<div class="pe-section" data-pe-section="unavailability" data-pe-unavail-host></div>`}
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

function renderPairingsSection(draft: DraftFields): string {
  const candidates = store.getAllParticipants();
  return `
    <div class="pe-section">
      <div class="pe-section-title">אי-זיווג</div>
      <div class="pe-field">
        <span class="pe-field-label">לא לזווג עם</span>
        <div class="pe-notwith" data-pe-notwith>
          ${renderNotWithChips(draft.notWithIds, candidates)}
          ${renderNotWithSelect(draft.notWithIds, candidates, '')}
        </div>
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

function renderNotWithSelect(selected: Set<string>, candidates: Participant[], excludeId: string): string {
  const remaining = candidates.filter((c) => c.id !== excludeId && !selected.has(c.id));
  if (remaining.length === 0) {
    return `<div class="pe-notwith-add-empty">אין משתתפים נוספים להוספה.</div>`;
  }
  const opts = remaining
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => `<option value="${escAttr(p.id)}">${escHtml(p.name)}</option>`)
    .join('');
  return `<select class="input-sm pe-input pe-notwith-add" data-pe-notwith-add>
    <option value="">+ הוסף משתתף…</option>
    ${opts}
  </select>`;
}

function renderUnavailabilitySection(participantId: string): string {
  const rules = store.getDateUnavailabilities(participantId);
  let cards = '';
  if (rules.length === 0) {
    cards = `<div class="pe-unavail-empty">לא הוגדרו חסימות. הוסף חוקי חסימה לימים ספציפיים בשבצ"ק.</div>`;
  } else {
    cards = rules.map(renderUnavailabilityCard).join('');
  }

  // Schedule-scoped Future-SOS read-only summary (linking to profile is out of scope here;
  // we just show the count so the user knows about it).
  const fsosCount = countFutureSosFor(participantId);
  const fsosNote =
    fsosCount > 0
      ? `<div class="pe-unavail-fsos-note">ⓘ קיימות ${fsosCount} חלונות אי-זמינות עתידית על השבצ"ק הנוכחי. ניתן לערוך אותן בפרופיל.</div>`
      : '';

  return `
    <div class="pe-section-title">אי זמינות קבועה</div>
    <div class="pe-unavail-list" data-pe-unavail-list>${cards}</div>
    <div class="pe-unavail-actions">
      <button type="button" class="btn-sm btn-primary pe-unavail-add" data-pe-unavail-add>+ הוסף חסימה</button>
    </div>
    ${fsosNote}
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

function countFutureSosFor(_participantId: string): number {
  // Read-only summary: walks the active schedule's scheduleUnavailability if loaded.
  // The editor doesn't have schedule context today, so we always return 0 (the
  // note will simply not render). Hook this up later by passing a getter into
  // showParticipantEditor when an FSOS-aware caller exists.
  return 0;
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
  });
  body.querySelectorAll<HTMLButtonElement>('[data-pe-mult-step]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = parseInt(btn.dataset.peMultStep || '0', 10);
      const next = Math.max(0.1, +(draft.workloadMultiplier + 0.1 * step).toFixed(2));
      draft.workloadMultiplier = next;
      multInput.value = formatWorkloadMultiplier(next);
    });
  });
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

function wirePairingsSection(body: HTMLElement, draft: DraftFields, participantId: string | undefined): void {
  const host = body.querySelector('[data-pe-notwith]') as HTMLElement;
  const rerenderNotWith = () => {
    const candidates = store.getAllParticipants();
    host.innerHTML =
      renderNotWithChips(draft.notWithIds, candidates) +
      renderNotWithSelect(draft.notWithIds, candidates, participantId ?? '');
    wireNotWith();
  };

  const wireNotWith = () => {
    host.querySelectorAll<HTMLButtonElement>('[data-pe-notwith-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.peNotwithRemove!;
        draft.notWithIds.delete(id);
        rerenderNotWith();
      });
    });
    const addSel = host.querySelector('[data-pe-notwith-add]') as HTMLSelectElement | null;
    if (addSel) {
      addSel.addEventListener('change', () => {
        const id = addSel.value;
        if (!id) return;
        draft.notWithIds.add(id);
        rerenderNotWith();
      });
    }
  };
  wireNotWith();
}

function wireUnavailabilitySection(host: HTMLElement, participantId: string, rerender: () => void): void {
  // Add new
  host.querySelector('[data-pe-unavail-add]')?.addEventListener('click', async () => {
    const result = await openUnavailPicker(participantId);
    if (!result) return;
    const rule = mapPickerResultToRule(result);
    if (!rule) return;
    store.addDateUnavailability(participantId, rule);
    rerender();
  });

  // Edit existing
  host.querySelectorAll<HTMLButtonElement>('[data-pe-unavail-edit]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.peUnavailEdit!;
      const rules = store.getDateUnavailabilities(participantId);
      const rule = rules.find((r) => r.id === id);
      if (!rule) return;
      const result = await openUnavailPicker(participantId, rule);
      if (!result) return;
      const next = mapPickerResultToRule(result);
      if (!next) return;
      // No "update" API — remove + re-add
      store.removeDateUnavailability(participantId, id);
      store.addDateUnavailability(participantId, next);
      rerender();
    });
  });

  // Delete existing
  host.querySelectorAll<HTMLButtonElement>('[data-pe-unavail-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.peUnavailDelete!;
      const ok = await showConfirm('להסיר את כלל החסימה?', {
        danger: true,
        title: 'הסרת חסימה',
        confirmLabel: 'הסר',
      });
      if (!ok) return;
      store.removeDateUnavailability(participantId, id);
      rerender();
    });
  });
}

async function openUnavailPicker(
  participantId: string,
  existing?: DateUnavailability,
): Promise<RangePickerResult | null> {
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
  void participantId; // could be used for future preview; reserved.

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

  let pid: string;
  if (!participantId) {
    const newP = store.addParticipant({
      name,
      level: draft.level,
      certifications: [...draft.certifications],
      pakalIds: [...draft.pakalIds],
      group,
      workloadMultiplier: draft.workloadMultiplier,
    });
    pid = newP.id;
    if (draft.preferredTaskName || draft.lessPreferredTaskName) {
      store.setTaskNamePreference(pid, draft.preferredTaskName || undefined, draft.lessPreferredTaskName || undefined);
    }
    showToast(`${name} נוסף/ה`, { type: 'success' });
  } else {
    pid = participantId;
    store.updateParticipant(pid, {
      name,
      level: draft.level,
      certifications: [...draft.certifications],
      pakalIds: [...draft.pakalIds],
      group,
      workloadMultiplier: draft.workloadMultiplier,
    });
    store.setTaskNamePreference(pid, draft.preferredTaskName || undefined, draft.lessPreferredTaskName || undefined);
    // Sync notWith
    const current = new Set(store.getNotWithIds(pid));
    for (const id of current) if (!draft.notWithIds.has(id)) store.removeNotWith(pid, id);
    for (const id of draft.notWithIds) if (!current.has(id)) store.addNotWith(pid, id);
  }

  return { participantId: pid };
}
