/**
 * Post-generation swap picker.
 *
 * Replaces the old `showPrompt`-based flow in `handleSwap()`. Presents a
 * rich candidate list (workload + badges + rejection reasons), a segmented
 * free/trade tab, filter + sort controls, a live preview panel driven by
 * `engine.previewSwap()` / `engine.previewSwapChain()`, and a confirm step.
 *
 * On commit the caller's `onCommit` handler fires with the pre-swap
 * assignment snapshot so the app-level undo stack can record it.
 */

import type { SwapPreview } from '../engine/scheduler';
import {
  type CandidateEligibility,
  getCandidatesWithEligibility,
  getEligibleParticipantsForSlot,
} from '../engine/validator';
import {
  type Assignment,
  AssignmentStatus,
  Level,
  type Participant,
  type ParticipantCapacity,
  type Schedule,
  type SchedulingEngine,
  type Task,
} from '../index';
import { computeAllCapacities } from '../utils/capacity';
import { renderParticipantCard } from './participant-card';
import { violationLabel } from './schedule-utils';
import { escHtml, fmt } from './ui-helpers';
import { showBottomSheet, showToast } from './ui-modal';
import { computeWeeklyWorkloads, type WeeklyWorkload } from './workload-utils';

export interface SwapPickerDeps {
  engine: SchedulingEngine;
  schedule: Schedule;
  disabledHC: Set<string>;
  restRuleMap: Map<string, number>;
  dayStartHour: number;
  /**
   * Called after the engine successfully commits the swap. The picker
   * passes the pre-commit assignments snapshot so the caller can push
   * it onto the unified undo stack.
   */
  onCommit: (info: { label: string; preCommitAssignments: Assignment[]; swappedAssignmentIds: string[] }) => void;
}

type PickerMode = 'free' | 'trade';
type PickerSort = 'eligibility' | 'workload-asc' | 'workload-desc' | 'name';

interface PickerState {
  assignmentId: string;
  mode: PickerMode;
  filter: {
    text: string;
    group: string | null;
    level: Level | null;
  };
  sort: PickerSort;
  selectedCandidateId: string | null;
  selectedTradeAssignmentId: string | null;
  preview: SwapPreview | null;
  committing: boolean;
}

interface ResolvedContext {
  sourceAssignment: Assignment;
  sourceTask: Task;
  sourceParticipant: Participant;
  candidates: CandidateEligibility[];
  tradeCandidates: TradeCandidate[];
  baselineWorkloads: Map<string, WeeklyWorkload>;
  capacities: Map<string, ParticipantCapacity>;
  /** Reference to the full task list — needed for post-swap workload recompute. */
  tasks: Task[];
  /** Reference to the full participant list — needed for affected-participant lookups. */
  participants: Participant[];
}

interface TradeCandidate {
  participant: Participant;
  assignment: Assignment;
  task: Task;
  /** Hebrew label like "הדליה — בוקר" */
  targetLabel: string;
}

/**
 * Open the swap picker as a bottom sheet. The sheet is used on both
 * mobile and desktop to keep the layout consistent; CSS media queries
 * handle visual differences.
 */
export async function openSwapPicker(assignmentId: string, deps: SwapPickerDeps): Promise<void> {
  const state: PickerState = {
    assignmentId,
    mode: 'free',
    filter: { text: '', group: null, level: null },
    sort: 'eligibility',
    selectedCandidateId: null,
    selectedTradeAssignmentId: null,
    preview: null,
    committing: false,
  };

  const ctx = resolveContext(state, deps);
  if (!ctx) {
    showToast('לא ניתן לפתוח החלפה — השיבוץ אינו זמין.', { type: 'error' });
    return;
  }

  const sheet = showBottomSheet(renderBody(state, ctx), {
    title: `החלפת משתתף — ${escHtml(cleanTaskName(ctx.sourceTask))}`,
  });
  sheet.el.classList.add('swap-picker-sheet');

  // After the sheet is painted, wire up events.
  requestAnimationFrame(() => {
    wireEvents(sheet.el, state, ctx, deps, () => sheet.close());
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Context resolution (runs once per open)
 * ──────────────────────────────────────────────────────────────────────── */

function resolveContext(state: PickerState, deps: SwapPickerDeps): ResolvedContext | null {
  const { engine, schedule, disabledHC, restRuleMap, dayStartHour } = deps;
  const sourceAssignment = schedule.assignments.find((a) => a.id === state.assignmentId);
  if (!sourceAssignment || sourceAssignment.status === AssignmentStatus.Frozen) return null;

  const sourceTask = schedule.tasks.find((t) => t.id === sourceAssignment.taskId);
  if (!sourceTask) return null;

  const sourceParticipant = schedule.participants.find((p) => p.id === sourceAssignment.participantId);
  if (!sourceParticipant) return null;

  // Schedule-scoped Future-SOS unavailability windows — layer on top of
  // participant master availability so focal participants don't surface as
  // candidates for slots that fall within their unavailability window.
  const extraUnavailability = schedule.scheduleUnavailability;
  const scheduleContext = engine.getScheduleContext();

  // Candidates: every participant with eligibility + rejection reason
  const candidates = getCandidatesWithEligibility(
    sourceTask,
    sourceAssignment.slotId,
    schedule.participants,
    schedule.assignments,
    schedule.tasks,
    disabledHC,
    restRuleMap,
    extraUnavailability,
    scheduleContext,
  ).filter((c) => c.participant.id !== sourceParticipant.id);

  // Trade candidates: for each OTHER assignment, check if the outgoing
  // participant can take that slot AND the other assignment's participant
  // is eligible for our source slot.
  const tradeCandidates = computeTradeCandidates(
    schedule,
    sourceAssignment,
    sourceTask,
    sourceParticipant,
    disabledHC,
    restRuleMap,
    extraUnavailability,
    scheduleContext,
  );

  // Capacities + workloads (baseline — used for "before" numbers in preview)
  const { start, end } = getScheduleWindow(schedule.tasks);
  const capacities = computeAllCapacities(schedule.participants, start, end, dayStartHour);
  const baselineWorkloads = computeWeeklyWorkloads(
    schedule.participants,
    schedule.assignments,
    schedule.tasks,
    capacities,
  );

  return {
    sourceAssignment,
    sourceTask,
    sourceParticipant,
    candidates,
    tradeCandidates,
    baselineWorkloads,
    capacities,
    tasks: schedule.tasks,
    participants: schedule.participants,
  };
}

function computeTradeCandidates(
  schedule: Schedule,
  sourceAssignment: Assignment,
  sourceTask: Task,
  sourceParticipant: Participant,
  disabledHC: Set<string>,
  restRuleMap: Map<string, number>,
  extraUnavailability: Array<{ participantId: string; start: Date; end: Date }> | undefined,
  scheduleContext: import('../shared/utils/time-utils').ScheduleContext | undefined,
): TradeCandidate[] {
  // Eligible participants for the source slot (used as filter A).
  const eligibleForSource = new Set(
    getEligibleParticipantsForSlot(
      sourceTask,
      sourceAssignment.slotId,
      schedule.participants,
      schedule.assignments,
      schedule.tasks,
      disabledHC,
      restRuleMap,
      extraUnavailability,
      scheduleContext,
    ).map((p) => p.id),
  );

  const trades: TradeCandidate[] = [];
  for (const candidate of schedule.assignments) {
    if (candidate.id === sourceAssignment.id) continue;
    if (candidate.participantId === sourceParticipant.id) continue;
    if (candidate.status === AssignmentStatus.Frozen) continue;
    if (!eligibleForSource.has(candidate.participantId)) continue;

    const candTask = schedule.tasks.find((t) => t.id === candidate.taskId);
    if (!candTask) continue;

    // Filter B: the source participant must be eligible for the candidate's slot
    const eligibleForCandidateSlot = new Set(
      getEligibleParticipantsForSlot(
        candTask,
        candidate.slotId,
        schedule.participants,
        schedule.assignments,
        schedule.tasks,
        disabledHC,
        restRuleMap,
        extraUnavailability,
        scheduleContext,
      ).map((p) => p.id),
    );
    if (!eligibleForCandidateSlot.has(sourceParticipant.id)) continue;

    const candParticipant = schedule.participants.find((p) => p.id === candidate.participantId);
    if (!candParticipant) continue;

    const slot = candTask.slots.find((s) => s.slotId === candidate.slotId);
    const slotLabel = slot?.label ? ` — ${slot.label}` : '';
    // U+2066 LRI + U+2069 PDI force the time range into an LTR isolate so the
    // two HH:mm runs don't get flipped by the surrounding RTL context after
    // the label is passed through escHtml.
    const timeRange = `\u2066${fmt(candTask.timeBlock.start)}–${fmt(candTask.timeBlock.end)}\u2069`;
    const targetLabel = `${cleanTaskName(candTask)}${slotLabel} (${timeRange})`;

    trades.push({
      participant: candParticipant,
      assignment: candidate,
      task: candTask,
      targetLabel,
    });
  }
  return trades;
}

function getScheduleWindow(tasks: Task[]): { start: Date; end: Date } {
  if (tasks.length === 0) {
    const now = new Date();
    return { start: now, end: now };
  }
  let start = tasks[0].timeBlock.start;
  let end = tasks[0].timeBlock.end;
  for (const t of tasks) {
    if (t.timeBlock.start < start) start = t.timeBlock.start;
    if (t.timeBlock.end > end) end = t.timeBlock.end;
  }
  return { start, end };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Rendering
 * ──────────────────────────────────────────────────────────────────────── */

function renderBody(state: PickerState, ctx: ResolvedContext): string {
  const header = renderHeader(state, ctx);
  const tabs = renderTabs(state);
  const filters = renderFilters(state, ctx);
  const list = state.mode === 'free' ? renderCandidateList(state, ctx) : renderTradeList(state, ctx);
  const preview = renderPreviewPanel(state, ctx);
  const actions = renderActions(state);
  // Preview + actions are wrapped in a single sticky footer so the preview
  // panel sits directly above the action bar without two elements fighting
  // for `position: sticky; bottom: 0`.
  return `<div class="swap-picker">
    ${header}
    ${tabs}
    ${filters}
    <div class="swap-picker-list" data-mode="${state.mode}">${list}</div>
    <div class="swap-picker-footer">
      ${preview}
      ${actions}
    </div>
  </div>`;
}

function renderHeader(_state: PickerState, ctx: ResolvedContext): string {
  const { sourceTask, sourceAssignment, sourceParticipant } = ctx;
  const slot = sourceTask.slots.find((s) => s.slotId === sourceAssignment.slotId);
  const slotLabel = slot?.label ? ` — ${slot.label}` : '';
  const timeRange = `<span dir="ltr">${fmt(sourceTask.timeBlock.start)} – ${fmt(sourceTask.timeBlock.end)}</span>`;
  return `<div class="swap-picker-header">
    <div class="swap-picker-title">${escHtml(cleanTaskName(sourceTask))}${escHtml(slotLabel)}</div>
    <div class="swap-picker-sub">${timeRange} · נוכחי: <strong>${escHtml(sourceParticipant.name)}</strong></div>
  </div>`;
}

function renderTabs(state: PickerState): string {
  return `<div class="swap-picker-tabs" role="tablist">
    <button class="swap-picker-tab ${state.mode === 'free' ? 'swap-picker-tab-active' : ''}" data-mode="free" role="tab">שיבוץ חדש</button>
    <button class="swap-picker-tab ${state.mode === 'trade' ? 'swap-picker-tab-active' : ''}" data-mode="trade" role="tab">החלפה הדדית</button>
  </div>`;
}

function renderFilters(state: PickerState, ctx: ResolvedContext): string {
  if (state.mode === 'trade') {
    // Trade mode: only text filter (groups/levels are less meaningful here)
    return `<div class="swap-picker-filters">
      <input type="search" class="swap-picker-search" id="swap-picker-search" placeholder="🔍 חפש..." value="${escHtml(state.filter.text)}" autocomplete="off" />
    </div>`;
  }

  const groupChips = uniqueGroups(ctx.candidates)
    .map(
      (g) =>
        `<button class="swap-picker-chip ${state.filter.group === g ? 'chip-active' : ''}" data-filter-group="${escHtml(g)}">${escHtml(g)}</button>`,
    )
    .join('');

  const levelChips = [Level.L0, Level.L2, Level.L3, Level.L4]
    .map(
      (lv) =>
        `<button class="swap-picker-chip ${state.filter.level === lv ? 'chip-active' : ''}" data-filter-level="${lv}">L${lv}</button>`,
    )
    .join('');

  return `<div class="swap-picker-filters">
    <input type="search" class="swap-picker-search" id="swap-picker-search" placeholder="🔍 חפש..." value="${escHtml(state.filter.text)}" autocomplete="off" />
    <select class="swap-picker-sort" id="swap-picker-sort">
      <option value="eligibility" ${state.sort === 'eligibility' ? 'selected' : ''}>מיון: זמינות</option>
      <option value="workload-asc" ${state.sort === 'workload-asc' ? 'selected' : ''}>מיון: עומס ↑</option>
      <option value="workload-desc" ${state.sort === 'workload-desc' ? 'selected' : ''}>מיון: עומס ↓</option>
      <option value="name" ${state.sort === 'name' ? 'selected' : ''}>מיון: שם</option>
    </select>
    <div class="swap-picker-chips">
      ${groupChips}
      <span class="swap-picker-chip-sep"></span>
      ${levelChips}
    </div>
  </div>`;
}

function renderCandidateList(state: PickerState, ctx: ResolvedContext): string {
  // Apply text / group / level filters to the full candidate pool
  const txt = state.filter.text.trim().toLowerCase();
  let candidates = ctx.candidates;
  if (txt) candidates = candidates.filter((c) => c.participant.name.toLowerCase().includes(txt));
  if (state.filter.group) candidates = candidates.filter((c) => c.participant.group === state.filter.group);
  if (state.filter.level !== null) candidates = candidates.filter((c) => c.participant.level === state.filter.level);

  // Empty-eligible fallback: if none of the filtered candidates are eligible,
  // render ALL filtered rows (greyed, with rejection reasons) so the user
  // can diagnose why nobody fits. Otherwise hide ineligible rows to keep
  // the list focused on actionable choices.
  const eligible = candidates.filter((c) => c.eligible);
  const showAllAsDiagnostic = eligible.length === 0 && candidates.length > 0;
  const display = showAllAsDiagnostic ? candidates : eligible;

  // Sort
  const sorted = sortCandidates([...display], state.sort, ctx.baselineWorkloads);

  if (sorted.length === 0) {
    return `<div class="swap-picker-empty">אין תוצאות לסינון זה.</div>`;
  }

  const banner = showAllAsDiagnostic
    ? `<div class="swap-picker-empty-banner">אין מועמדים זמינים להחלפה. מוצגים כל המשתתפים עם סיבת הדחייה לכל אחד.</div>`
    : '';

  const cards = sorted
    .map((c) => {
      const wl = ctx.baselineWorkloads.get(c.participant.id);
      return renderParticipantCard({
        participant: c.participant,
        eligible: c.eligible,
        rejectionReason: c.reason,
        workload: wl,
        capacity: ctx.capacities.get(c.participant.id),
        // Badge shows effective hours so the corner number matches the
        // sorting criterion (workload sorts use `effectiveHours`). Keeping
        // these aligned prevents the puzzling "list ordered by one metric,
        // badge shows another" mismatch.
        loadBadge: wl ? loadBadgeForWorkload(wl) : undefined,
        selected: state.selectedCandidateId === c.participant.id,
        extraClass: 'warehouse-card-sheet',
      });
    })
    .join('');

  return banner + cards;
}

function renderTradeList(state: PickerState, ctx: ResolvedContext): string {
  let trades = ctx.tradeCandidates;
  const txt = state.filter.text.trim().toLowerCase();
  if (txt) {
    trades = trades.filter(
      (t) => t.participant.name.toLowerCase().includes(txt) || t.targetLabel.toLowerCase().includes(txt),
    );
  }

  if (trades.length === 0) {
    return `<div class="swap-picker-empty">אין שיבוצים שניתן להחליף אתם (נדרשת זכאות הדדית למשבצות).</div>`;
  }

  return trades
    .map((tc) => {
      const wl = ctx.baselineWorkloads.get(tc.participant.id);
      const card = renderParticipantCard({
        participant: tc.participant,
        eligible: true,
        workload: wl,
        capacity: ctx.capacities.get(tc.participant.id),
        loadBadge: wl ? loadBadgeForWorkload(wl) : undefined,
        selected: state.selectedTradeAssignmentId === tc.assignment.id,
        extraClass: 'warehouse-card-sheet swap-trade-card',
        extraDataAttrs: `data-trade-assignment-id="${tc.assignment.id}"`,
      });
      return `<div class="swap-trade-row">
        ${card}
        <div class="swap-trade-target">${escHtml(tc.targetLabel)}</div>
      </div>`;
    })
    .join('');
}

function renderPreviewPanel(state: PickerState, ctx: ResolvedContext): string {
  if (!state.preview) {
    return `<div class="swap-preview-panel swap-preview-empty">בחר/י מועמד כדי לראות השפעת ההחלפה.</div>`;
  }

  const preview = state.preview;

  // Recompute post-swap workloads from the simulated assignments snapshot
  // so the UI can show the "after" numbers without re-mutating the engine.
  const postWorkloads = computeWeeklyWorkloads(
    getAffectedParticipants(ctx, preview),
    preview.simulatedAssignments,
    ctx.tasks,
    ctx.capacities,
  );

  const deltaRows = preview.affectedParticipantIds
    .map((pid) => {
      const p = getParticipantById(ctx, pid);
      if (!p) return '';
      const before = ctx.baselineWorkloads.get(pid);
      const after = postWorkloads.get(pid);
      if (!before || !after) return '';
      return renderDeltaRow(p, before, after);
    })
    .join('');

  const violationsHtml = preview.violations.length
    ? `<ul class="swap-preview-violations">${preview.violations
        .map((v) => `<li dir="rtl"><code>${violationLabel(v.code)}</code> · ${escHtml(v.message)}</li>`)
        .join('')}</ul>`
    : '';

  const addedHtml = preview.addedSoftWarnings.length
    ? `<div class="swap-preview-soft swap-preview-soft-added">
        <div class="swap-preview-soft-label">אזהרות חדשות:</div>
        <ul>${preview.addedSoftWarnings.map((w) => `<li dir="rtl"><code>${violationLabel(w.code)}</code> · ${escHtml(w.message)}</li>`).join('')}</ul>
      </div>`
    : '';
  const removedHtml = preview.removedSoftWarnings.length
    ? `<div class="swap-preview-soft swap-preview-soft-removed">
        <div class="swap-preview-soft-label">אזהרות שבוטלו:</div>
        <ul>${preview.removedSoftWarnings.map((w) => `<li dir="rtl"><code>${violationLabel(w.code)}</code> · ${escHtml(w.message)}</li>`).join('')}</ul>
      </div>`
    : '';

  const statusBadge = preview.valid
    ? `<span class="swap-preview-ok">תקין</span>`
    : `<span class="swap-preview-bad">לא תקין</span>`;

  return `<div class="swap-preview-panel ${preview.valid ? '' : 'swap-preview-invalid'}">
    <div class="swap-preview-header">תצוגה מקדימה ${statusBadge}</div>
    <div class="swap-preview-deltas">${deltaRows}</div>
    ${violationsHtml}
    ${addedHtml}
    ${removedHtml}
  </div>`;
}

function renderDeltaRow(p: Participant, before: WeeklyWorkload, after: WeeklyWorkload): string {
  const deltaEff = after.effectiveHours - before.effectiveHours;
  const sign = deltaEff > 0 ? '+' : '';
  const deltaClass = deltaEff > 0 ? 'swap-delta-up' : deltaEff < 0 ? 'swap-delta-down' : 'swap-delta-same';
  // dir="ltr" on the values span keeps "before → after" in logical order
  // (arrow pointing with reading flow) regardless of the RTL parent. The
  // Hebrew "שע׳" inside remains strong-RTL and still renders correctly.
  return `<div class="swap-preview-delta-row">
    <span class="swap-preview-delta-name">${escHtml(p.name)}</span>
    <span class="swap-preview-delta-values" dir="ltr">
      ${before.effectiveHours.toFixed(1)} → ${after.effectiveHours.toFixed(1)} שע׳
      <span class="${deltaClass}">(${sign}${deltaEff.toFixed(1)})</span>
    </span>
  </div>`;
}

function renderActions(state: PickerState): string {
  const canConfirm = state.preview?.valid && !state.committing;
  return `<div class="swap-picker-actions">
    <button class="btn-outline swap-picker-cancel">ביטול</button>
    <button class="btn-primary swap-picker-confirm" ${canConfirm ? '' : 'disabled'}>אישור החלפה</button>
  </div>`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Event wiring & re-render
 * ──────────────────────────────────────────────────────────────────────── */

function wireEvents(
  root: HTMLElement,
  state: PickerState,
  ctx: ResolvedContext,
  deps: SwapPickerDeps,
  close: () => void,
): void {
  const rerender = (): void => {
    const body = root.querySelector('.gm-bs-body');
    if (!body) return;
    body.innerHTML = renderBody(state, ctx);
    wireEvents(root, state, ctx, deps, close);
  };

  // Tab switching
  root.querySelectorAll('.swap-picker-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = (btn as HTMLElement).dataset.mode as PickerMode;
      if (state.mode === mode) return;
      state.mode = mode;
      state.selectedCandidateId = null;
      state.selectedTradeAssignmentId = null;
      state.preview = null;
      rerender();
    });
  });

  // Search input
  const search = root.querySelector<HTMLInputElement>('#swap-picker-search');
  if (search) {
    search.addEventListener('input', () => {
      state.filter.text = search.value;
      // Only re-render the list + preview, keep focus.
      const list = root.querySelector('.swap-picker-list');
      if (list) {
        list.innerHTML = state.mode === 'free' ? renderCandidateList(state, ctx) : renderTradeList(state, ctx);
        wireCardClicks(root, state, ctx, deps, rerender);
      }
    });
  }

  // Sort dropdown
  const sortSel = root.querySelector<HTMLSelectElement>('#swap-picker-sort');
  if (sortSel) {
    sortSel.addEventListener('change', () => {
      state.sort = sortSel.value as PickerSort;
      rerender();
    });
  }

  // Chip filters (groups / levels)
  root.querySelectorAll('[data-filter-group]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = (btn as HTMLElement).dataset.filterGroup ?? '';
      state.filter.group = state.filter.group === g ? null : g;
      rerender();
    });
  });
  root.querySelectorAll('[data-filter-level]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const lv = Number((btn as HTMLElement).dataset.filterLevel ?? '0') as Level;
      state.filter.level = state.filter.level === lv ? null : lv;
      rerender();
    });
  });

  // Card clicks (free mode) + trade-row clicks (trade mode)
  wireCardClicks(root, state, ctx, deps, rerender);

  // Cancel / Confirm
  root.querySelector('.swap-picker-cancel')?.addEventListener('click', close);
  root.querySelector('.swap-picker-confirm')?.addEventListener('click', () => {
    commitSwap(state, ctx, deps, close);
  });
}

function wireCardClicks(
  root: HTMLElement,
  state: PickerState,
  ctx: ResolvedContext,
  deps: SwapPickerDeps,
  rerender: () => void,
): void {
  root.querySelectorAll('.swap-picker-list .warehouse-card').forEach((cardEl) => {
    cardEl.addEventListener('click', () => {
      const pid = (cardEl as HTMLElement).dataset.pid;
      const tradeId = (cardEl as HTMLElement).dataset.tradeAssignmentId;
      if (!pid) return;

      if (state.mode === 'trade' && tradeId) {
        state.selectedTradeAssignmentId = tradeId;
        state.selectedCandidateId = pid;
        state.preview = computeTradePreview(state, ctx, deps);
      } else if (state.mode === 'free') {
        // Ineligible candidates are non-interactive (their card is a diagnostic)
        const candidate = ctx.candidates.find((c) => c.participant.id === pid);
        if (!candidate?.eligible) return;
        state.selectedCandidateId = pid;
        state.selectedTradeAssignmentId = null;
        state.preview = deps.engine.previewSwap({
          assignmentId: state.assignmentId,
          newParticipantId: pid,
        });
      }
      rerender();
    });
  });
}

function computeTradePreview(state: PickerState, ctx: ResolvedContext, deps: SwapPickerDeps): SwapPreview | null {
  const tradeId = state.selectedTradeAssignmentId;
  if (!tradeId) return null;
  const other = deps.schedule.assignments.find((a) => a.id === tradeId);
  if (!other) return null;
  // Atomic two-way: source gets other's participant; other gets source's participant.
  return deps.engine.previewSwapChain([
    { assignmentId: state.assignmentId, newParticipantId: other.participantId },
    { assignmentId: other.id, newParticipantId: ctx.sourceParticipant.id },
  ]);
}

function commitSwap(state: PickerState, ctx: ResolvedContext, deps: SwapPickerDeps, close: () => void): void {
  if (state.committing) return;
  if (!state.preview?.valid) return;
  state.committing = true;

  const preCommitAssignments = deps.schedule.assignments.map((a) => ({ ...a }));

  let result: ReturnType<SchedulingEngine['swapParticipant']>;
  let label: string;
  let swappedAssignmentIds: string[];
  if (state.mode === 'trade' && state.selectedTradeAssignmentId) {
    const other = deps.schedule.assignments.find((a) => a.id === state.selectedTradeAssignmentId);
    if (!other) {
      state.committing = false;
      return;
    }
    const otherP = deps.schedule.participants.find((p) => p.id === other.participantId);
    result = deps.engine.swapParticipantChain([
      { assignmentId: state.assignmentId, newParticipantId: other.participantId },
      { assignmentId: other.id, newParticipantId: ctx.sourceParticipant.id },
    ]);
    label = `החלפה הדדית: ${ctx.sourceParticipant.name} ⇄ ${otherP?.name ?? ''}`;
    swappedAssignmentIds = [state.assignmentId, state.selectedTradeAssignmentId];
  } else if (state.selectedCandidateId) {
    const inc = deps.schedule.participants.find((p) => p.id === state.selectedCandidateId);
    result = deps.engine.swapParticipant({
      assignmentId: state.assignmentId,
      newParticipantId: state.selectedCandidateId,
    });
    // RTL reading: rightmost name is read first. We put the incoming
    // participant on the right and the outgoing (source) on the left so
    // the arrow reads "incoming ← outgoing" = "incoming replaces outgoing".
    label = `החלפה: ${inc?.name ?? ''} ← ${ctx.sourceParticipant.name}`;
    swappedAssignmentIds = [state.assignmentId];
  } else {
    state.committing = false;
    return;
  }

  if (!result.valid) {
    state.committing = false;
    const msgs = result.violations.map((v) => `${violationLabel(v.code)}: ${v.message}`).join('\n');
    showToast(`ההחלפה נכשלה: ${msgs}`, { type: 'error' });
    return;
  }

  close();
  deps.onCommit({ label, preCommitAssignments, swappedAssignmentIds });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────── */

function uniqueGroups(candidates: CandidateEligibility[]): string[] {
  const set = new Set<string>();
  for (const c of candidates) set.add(c.participant.group);
  return [...set].sort();
}

/**
 * Build the corner badge payload from a participant's weekly workload.
 * Displays `effectiveHours` — the same metric the workload sorts use —
 * so the badge always reflects the actual ordering criterion.
 */
function loadBadgeForWorkload(workload: WeeklyWorkload): { text: string; tooltip: string } {
  const eff = workload.effectiveHours.toFixed(1);
  return { text: `${eff}h`, tooltip: `שעות אפקטיביות: ${eff}` };
}

function sortCandidates(
  list: CandidateEligibility[],
  sort: PickerSort,
  workloads: Map<string, WeeklyWorkload>,
): CandidateEligibility[] {
  switch (sort) {
    case 'eligibility':
      return list.sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        const aw = workloads.get(a.participant.id)?.effectiveHours ?? 0;
        const bw = workloads.get(b.participant.id)?.effectiveHours ?? 0;
        if (aw !== bw) return aw - bw;
        return a.participant.name.localeCompare(b.participant.name, 'he');
      });
    case 'workload-asc':
      return list.sort((a, b) => {
        const aw = workloads.get(a.participant.id)?.effectiveHours ?? 0;
        const bw = workloads.get(b.participant.id)?.effectiveHours ?? 0;
        return aw - bw;
      });
    case 'workload-desc':
      return list.sort((a, b) => {
        const aw = workloads.get(a.participant.id)?.effectiveHours ?? 0;
        const bw = workloads.get(b.participant.id)?.effectiveHours ?? 0;
        return bw - aw;
      });
    case 'name':
      return list.sort((a, b) => a.participant.name.localeCompare(b.participant.name, 'he'));
  }
}

function cleanTaskName(task: Task): string {
  return (task.sourceName || task.name).replace(/^D\d+\s+/, '');
}

function getAffectedParticipants(ctx: ResolvedContext, preview: SwapPreview): Participant[] {
  const set = new Set(preview.affectedParticipantIds);
  return ctx.participants.filter((p) => set.has(p.id));
}

function getParticipantById(ctx: ResolvedContext, id: string): Participant | null {
  return ctx.participants.find((p) => p.id === id) ?? null;
}
