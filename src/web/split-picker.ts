/**
 * Manual-build split picker.
 *
 * The only flow that lets the user CREATE a split themselves (every other
 * split — Stage-4, Phase-2, rescue, FSOS, BALTAM, capability-change — picks
 * the halves automatically). The picker opens from the warehouse-sheet header
 * for a splittable, non-already-split slot in manual-build mode and lets the
 * user pick two distinct participants — one per half. Pre-fills Half A with
 * the current incumbent when the slot is already assigned; both halves start
 * empty for an empty slot.
 *
 * Apply path: builds a `SplitOp` and calls `engine.applyPlanOps({ splitOps:
 * [op] })`. The engine validates HC-1/3/4/8/12/15/16 + same-group link-union
 * against the full schedule and rolls back atomically on failure. The picker
 * shows an inline error banner and stays open on HC rejection.
 */

import { makeSplitHalf } from '../engine/optimizer';
import type { SchedulingEngine } from '../engine/scheduler';
import { isEligible } from '../engine/validator';
import type { Assignment, Participant, Schedule, SlotRequirement, SplitOp, Task } from '../models/types';
import { renderParticipantCard } from './participant-card';
import { escAttr, escHtml, fmt, stripDayPrefix } from './ui-helpers';
import { showBottomSheet } from './ui-modal';

export interface SplitPickerDeps {
  engine: SchedulingEngine;
  schedule: Schedule;
  taskId: string;
  slotId: string;
  disabledHC: Set<string>;
  restRuleMap: Map<string, number>;
  /** Push a manual-build undo snapshot — called just before applyPlanOps. */
  pushUndo: () => void;
  /** Pop the manual-build undo snapshot — called when apply fails (engine
   *  already rolled back, the snapshot is identical to the current state). */
  popUndo: () => void;
}

export interface SplitPickerResult {
  applied: boolean;
  /** When applied: the two new half-assignment ids, in [A, B] order. */
  halfAssignmentIds: [string, string] | null;
}

interface PickerState {
  activeHalf: 'A' | 'B';
  pickA: { participant: Participant } | null;
  pickB: { participant: Participant } | null;
  searchText: string;
  /** Latest inline-banner error message (HC violation etc.); cleared on
   *  every state change. */
  errorMessage: string | null;
}

/**
 * Open the split picker as a bottom sheet. Resolves when the sheet closes.
 * On `applied: true` the schedule has been mutated by `applyPlanOps` and
 * the caller should `revalidateAndRefresh` + push `halfAssignmentIds` into
 * the animation queue. On `applied: false` the schedule is unchanged.
 */
export function openSplitPicker(deps: SplitPickerDeps): Promise<SplitPickerResult> {
  const task = deps.schedule.tasks.find((t) => t.id === deps.taskId);
  const slot = task?.slots.find((s) => s.slotId === deps.slotId);
  if (!task || !slot) {
    return Promise.resolve({ applied: false, halfAssignmentIds: null });
  }

  const existingAssignment = deps.schedule.assignments.find((a) => a.taskId === task.id && a.slotId === slot.slotId);
  const existingParticipant = existingAssignment
    ? (deps.schedule.participants.find((p) => p.id === existingAssignment.participantId) ?? null)
    : null;

  // Pre-fill Half A with the current incumbent (when the slot is filled).
  // The user can clear and pick someone else; the common case is to keep
  // the incumbent on the first half and bring in relief for the second.
  const state: PickerState = {
    activeHalf: existingParticipant ? 'B' : 'A',
    pickA: existingParticipant ? { participant: existingParticipant } : null,
    pickB: null,
    searchText: '',
    errorMessage: null,
  };

  // Compute midpoint + virtual halves once — they're frozen for the picker's
  // lifetime. The picker never lets the user choose a midpoint.
  const startMs = task.timeBlock.start.getTime();
  const endMs = task.timeBlock.end.getTime();
  const midMs = startMs + Math.floor((endMs - startMs) / 2);
  const halfA = makeSplitHalf(task, 1, startMs, midMs, slot);
  const halfB = makeSplitHalf(task, 2, midMs, endMs, slot);

  // The participant lists for each half are computed against an assignment
  // view where the existing slot assignment is REMOVED (it's about to be
  // replaced by the two halves). Without this, the current incumbent would
  // be rejected from both halves by HC-4 overlap against the parent task.
  const excludeAsgIds = new Set<string>(existingAssignment ? [existingAssignment.id] : []);
  const taskMap = new Map<string, Task>(deps.schedule.tasks.map((t) => [t.id, t]));

  const eligibleA = computeEligible(
    halfA,
    deps.schedule.participants,
    deps.schedule.assignments,
    taskMap,
    task.id,
    excludeAsgIds,
    deps.disabledHC,
    deps.restRuleMap,
    deps.schedule.scheduleUnavailability,
    deps.engine,
  );
  const eligibleB = computeEligible(
    halfB,
    deps.schedule.participants,
    deps.schedule.assignments,
    taskMap,
    task.id,
    excludeAsgIds,
    deps.disabledHC,
    deps.restRuleMap,
    deps.schedule.scheduleUnavailability,
    deps.engine,
  );

  return new Promise<SplitPickerResult>((resolve) => {
    let resolved = false;
    const result: SplitPickerResult = { applied: false, halfAssignmentIds: null };

    const sheet = showBottomSheet(
      renderBody(state, task, slot, halfA, halfB, eligibleA, eligibleB, deps.schedule.participants),
      {
        title: `פיצול משבצת — ${escHtml(stripDayPrefix(task.sourceName ?? task.name))}`,
        onClose: () => {
          if (!resolved) {
            resolved = true;
            resolve(result);
          }
        },
      },
    );
    sheet.el.classList.add('split-picker-sheet');

    const rerender = (): void => {
      const body = sheet.el.querySelector('.gm-bs-body');
      if (!body) return;
      body.innerHTML = renderBody(state, task, slot, halfA, halfB, eligibleA, eligibleB, deps.schedule.participants);
      wireEvents();
    };

    const close = (applied: boolean, halfIds: [string, string] | null): void => {
      if (resolved) return;
      resolved = true;
      result.applied = applied;
      result.halfAssignmentIds = halfIds;
      sheet.close();
      resolve(result);
    };

    const wireEvents = (): void => {
      const body = sheet.el.querySelector('.gm-bs-body');
      if (!body) return;

      // Half-slot row clicks: switch active half, or clear pick on ✕.
      body.querySelectorAll<HTMLElement>('[data-action="activate-half"]').forEach((el) => {
        el.addEventListener('click', (e) => {
          // Don't trigger activation when the user clicked the inner ✕.
          if ((e.target as HTMLElement).closest('[data-action="clear-half"]')) return;
          const which = el.dataset.half as 'A' | 'B';
          state.activeHalf = which;
          state.errorMessage = null;
          rerender();
        });
      });
      body.querySelectorAll<HTMLElement>('[data-action="clear-half"]').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const which = el.dataset.half as 'A' | 'B';
          if (which === 'A') state.pickA = null;
          else state.pickB = null;
          state.activeHalf = which;
          state.errorMessage = null;
          rerender();
        });
      });

      // Participant card click → set the pick for the active half.
      body.querySelectorAll<HTMLElement>('.warehouse-card[data-pid]').forEach((el) => {
        el.addEventListener('click', () => {
          const pid = el.dataset.pid;
          if (!pid) return;
          const participant = deps.schedule.participants.find((p) => p.id === pid);
          if (!participant) return;
          const which = state.activeHalf;
          // Reject choosing the other half's pick.
          const other = which === 'A' ? state.pickB : state.pickA;
          if (other && other.participant.id === pid) {
            state.errorMessage = 'אי-אפשר לשבץ את אותו אדם בשני החצאים.';
            rerender();
            return;
          }
          if (which === 'A') state.pickA = { participant };
          else state.pickB = { participant };
          // Auto-advance to the other half if it's still empty.
          if (which === 'A' && !state.pickB) state.activeHalf = 'B';
          else if (which === 'B' && !state.pickA) state.activeHalf = 'A';
          state.errorMessage = null;
          rerender();
        });
      });

      // Search input — preserve focus + caret across re-render.
      const search = body.querySelector<HTMLInputElement>('#split-picker-search');
      if (search) {
        search.addEventListener('input', () => {
          state.searchText = search.value;
          const caret = search.selectionStart;
          rerender();
          requestAnimationFrame(() => {
            const next = sheet.el.querySelector<HTMLInputElement>('#split-picker-search');
            if (next) {
              next.focus();
              if (caret !== null) next.setSelectionRange(caret, caret);
            }
          });
        });
      }

      // Cancel + confirm buttons.
      const cancelBtn = sheet.el.querySelector<HTMLButtonElement>('[data-action="split-cancel"]');
      if (cancelBtn) cancelBtn.addEventListener('click', () => close(false, null));
      const confirmBtn = sheet.el.querySelector<HTMLButtonElement>('[data-action="split-confirm"]');
      if (confirmBtn) {
        confirmBtn.addEventListener('click', () => {
          if (!state.pickA || !state.pickB) return;
          if (state.pickA.participant.id === state.pickB.participant.id) {
            state.errorMessage = 'אי-אפשר לשבץ את אותו אדם בשני החצאים.';
            rerender();
            return;
          }
          // Build the SplitOp and apply.
          const op: SplitOp = {
            kind: 'split',
            taskId: task.id,
            slotId: slot.slotId,
            taskName: task.name,
            slotLabel: slot.label ?? slot.slotId,
            originalAssignmentId: existingAssignment?.id ?? null,
            originalParticipantId: existingAssignment?.participantId ?? null,
            midpointMs: midMs,
            fillA: {
              participantId: state.pickA.participant.id,
              displayName: state.pickA.participant.name,
            },
            fillB: {
              participantId: state.pickB.participant.id,
              displayName: state.pickB.participant.name,
            },
            groupLock: task.sameGroupRequired ? state.pickA.participant.group : undefined,
            sameGroupLinkId: task.sameGroupRequired ? (task.sameGroupLinkId ?? task.id) : undefined,
          };
          deps.pushUndo();
          const res = deps.engine.applyPlanOps({ splitOps: [op] });
          if (!res.valid) {
            deps.popUndo();
            state.errorMessage = res.violations[0]?.message ?? 'פיצול נכשל.';
            rerender();
            return;
          }
          // Success — derive the synthesized half-assignment ids by finding
          // the two assignments the engine just pushed onto schedule.assignments.
          // They're keyed by halfA.id / halfB.id which the engine produced via
          // makeSplitHalf, so we can locate them deterministically.
          const newA = deps.schedule.assignments.find(
            (a) => a.taskId === halfA.id && a.slotId === halfA.slots[0].slotId,
          );
          const newB = deps.schedule.assignments.find(
            (a) => a.taskId === halfB.id && a.slotId === halfB.slots[0].slotId,
          );
          const halfIds: [string, string] = [newA?.id ?? '', newB?.id ?? ''];
          close(true, halfIds);
        });
      }
    };

    requestAnimationFrame(wireEvents);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
 * Eligibility per virtual half
 * ──────────────────────────────────────────────────────────────────────── */

function computeEligible(
  halfTask: Task,
  participants: Participant[],
  allAssignments: Assignment[],
  taskMap: Map<string, Task>,
  parentTaskId: string,
  excludeAsgIds: Set<string>,
  disabledHC: Set<string>,
  restRuleMap: Map<string, number>,
  extraUnavailability: { participantId: string; start: Date; end: Date }[] | undefined,
  engine: SchedulingEngine,
): Set<string> {
  const slot = halfTask.slots[0];
  const participantMap = new Map<string, Participant>(participants.map((p) => [p.id, p]));
  // Task-level assignments (other slots of the parent occurrence) MINUS the
  // one we're about to replace. Lets HC-8 link-union + HC-5/HC-7 see who
  // currently holds the surviving slots of the same occurrence.
  const taskAssignments = allAssignments.filter((a) => a.taskId === parentTaskId && !excludeAsgIds.has(a.id));
  const scheduleContext = engine.getScheduleContext();

  const result = new Set<string>();
  for (const p of participants) {
    // Per-participant assignments view: everything they hold MINUS the
    // assignment we're about to replace. Mirrors `participantAssignmentsExcluding`
    // in rescue-primitives.ts.
    const pAsgs = allAssignments.filter((a) => a.participantId === p.id && !excludeAsgIds.has(a.id));
    const ok = isEligible(p, halfTask, slot, pAsgs, taskMap, {
      checkSameGroup: true,
      participantMap,
      disabledHC,
      restRuleMap,
      extraUnavailability,
      scheduleContext,
      taskAssignments,
    });
    if (ok) result.add(p.id);
  }
  return result;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Rendering
 * ──────────────────────────────────────────────────────────────────────── */

function renderBody(
  state: PickerState,
  task: Task,
  slot: SlotRequirement,
  halfA: Task,
  halfB: Task,
  eligibleA: Set<string>,
  eligibleB: Set<string>,
  participants: Participant[],
): string {
  const slotLabel = slot.label ? ` · ${escHtml(slot.label)}` : '';
  const fullWindow = `<span dir="ltr">${fmt(task.timeBlock.start)} – ${fmt(task.timeBlock.end)}</span>`;
  const halfAWindow = `<span dir="ltr">${fmt(halfA.timeBlock.start)} – ${fmt(halfA.timeBlock.end)}</span>`;
  const halfBWindow = `<span dir="ltr">${fmt(halfB.timeBlock.start)} – ${fmt(halfB.timeBlock.end)}</span>`;
  const cleanName = escHtml(stripDayPrefix(task.sourceName ?? task.name));

  const header = `<div class="split-picker-header">
    <div class="split-picker-title">${cleanName}${slotLabel}</div>
    <div class="split-picker-subtitle">${fullWindow}</div>
  </div>`;

  const slotRow = (which: 'A' | 'B', pick: { participant: Participant } | null, window: string): string => {
    const active = state.activeHalf === which;
    const cls = ['split-picker-half'];
    cls.push(active ? 'split-picker-half--active' : '');
    cls.push(pick ? 'split-picker-half--filled' : 'split-picker-half--empty');
    const label = which === 'A' ? 'חצי ראשון' : 'חצי שני';
    const content = pick
      ? `<span class="split-picker-half-name">${escHtml(pick.participant.name)}</span>
         <button class="split-picker-half-clear" data-action="clear-half" data-half="${which}" type="button" aria-label="הסר">✕</button>`
      : `<span class="split-picker-half-placeholder">בחר משתתף ↓</span>`;
    return `<div class="${cls.filter(Boolean).join(' ')}" data-action="activate-half" data-half="${which}" role="button" tabindex="0">
      <div class="split-picker-half-meta"><span class="split-picker-half-label">${label}</span><span class="split-picker-half-window">${window}</span></div>
      <div class="split-picker-half-body">${content}</div>
    </div>`;
  };

  const halves = `<div class="split-picker-halves">
    ${slotRow('A', state.pickA, halfAWindow)}
    ${slotRow('B', state.pickB, halfBWindow)}
  </div>`;

  // Group lock indicator when sameGroupRequired and at least one half picked.
  const groupLockedTo =
    task.sameGroupRequired && (state.pickA || state.pickB)
      ? (state.pickA?.participant.group ?? state.pickB?.participant.group)
      : undefined;

  // Candidate list for the active half — show eligible first, then ineligible
  // greyed out (so the user understands WHY a name is missing), then sort by
  // Hebrew name within each bucket. Mirrors the warehouse-sheet ordering.
  const activePool = state.activeHalf === 'A' ? eligibleA : eligibleB;
  const otherPick = state.activeHalf === 'A' ? state.pickB : state.pickA;
  const searchLower = state.searchText.trim().toLowerCase();
  const sortedParticipants = [...participants].sort((a, b) => {
    const aElig = activePool.has(a.id) ? 0 : 1;
    const bElig = activePool.has(b.id) ? 0 : 1;
    if (aElig !== bElig) return aElig - bElig;
    return a.name.localeCompare(b.name, 'he');
  });
  const candidates: Participant[] = [];
  for (const p of sortedParticipants) {
    if (searchLower && !p.name.toLowerCase().includes(searchLower)) continue;
    if (groupLockedTo && p.group !== groupLockedTo) continue;
    candidates.push(p);
  }
  const cards = candidates
    .map((p) => {
      const eligible = activePool.has(p.id);
      const isOther = otherPick?.participant.id === p.id;
      const isSelf =
        (state.activeHalf === 'A' && state.pickA?.participant.id === p.id) ||
        (state.activeHalf === 'B' && state.pickB?.participant.id === p.id);
      const reject = isOther ? 'משובץ בחצי השני' : !eligible ? 'אינו עומד באילוצים' : null;
      return renderParticipantCard({
        participant: p,
        eligible: eligible && !isOther,
        rejectionReason: reject,
        selected: isSelf,
        extraClass: 'split-picker-card',
      });
    })
    .join('');

  const groupLockNotice = groupLockedTo
    ? `<div class="split-picker-grouplock">משימה דורשת אותה קבוצה — מסונן ל-${escHtml(groupLockedTo)}</div>`
    : '';

  const search = `<div class="split-picker-search-row">
    <input type="search" id="split-picker-search" class="split-picker-search" placeholder="🔍 חפש משתתף" value="${escAttr(state.searchText)}" autocomplete="off" />
  </div>`;

  const list = `<div class="split-picker-cards">${cards || '<div class="split-picker-empty">אין מועמדים זמינים</div>'}</div>`;

  const errorBanner = state.errorMessage
    ? `<div class="split-picker-error">⚠ ${escHtml(state.errorMessage)}</div>`
    : '';

  const confirmDisabled = !state.pickA || !state.pickB || state.pickA.participant.id === state.pickB.participant.id;

  const actions = `<div class="split-picker-actions">
    <button class="btn btn-secondary" data-action="split-cancel" type="button">ביטול</button>
    <button class="btn btn-primary" data-action="split-confirm" type="button" ${confirmDisabled ? 'disabled' : ''}>✅ אישור פיצול</button>
  </div>`;

  return `${header}${halves}${groupLockNotice}${search}${list}${errorBanner}${actions}`;
}
