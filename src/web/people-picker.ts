/**
 * People Picker — reusable searchable multi-select bottom sheet for choosing
 * a set of participants ("pick N people").
 *
 * Built on the shared `showBottomSheet` primitive, so it inherits the backdrop,
 * swipe-to-dismiss, Escape handling, nestable body-scroll lock, and (via
 * `aria-modal="true"`) the global focus trap — and it stacks cleanly on top of
 * another open modal (e.g. the participant editor sheet).
 *
 * Usage mirrors the editor's other nested sheet (`await showRangePicker()`):
 *   const result = await showPeoplePicker({ title, candidates, selected });
 *   if (result) draft.notWithIds = result;   // null ⇒ cancelled, leave draft as-is
 *
 * The picker is self-contained: it works on a private copy of `selected` and
 * only resolves the new set on אישור, so the caller's data is untouched until
 * the user confirms. Search is a pure DOM overlay (no re-render, input keeps
 * focus); tapping a row toggles its state in place.
 */

import type { Participant } from '../models/types';
import { escAttr, escHtml, groupBadge } from './ui-helpers';
import { showBottomSheet } from './ui-modal';

export interface PeoplePickerOptions {
  /** Sheet title, e.g. 'לא לזווג עם'. */
  title: string;
  /** Full candidate pool (typically store.getAllParticipants()). */
  candidates: Participant[];
  /** Currently-selected ids; used to pre-check rows. Not mutated. */
  selected: Set<string>;
  /** Participant to hide from the list (e.g. the person being edited). */
  excludeId?: string;
  /** Message shown when the candidate pool is empty. */
  emptyHint?: string;
}

/**
 * Show the picker. Resolves to a NEW Set of selected ids on אישור, or `null`
 * if the user cancels / dismisses (ביטול, ×, Esc, backdrop tap, swipe-down).
 */
export function showPeoplePicker(opts: PeoplePickerOptions): Promise<Set<string> | null> {
  return new Promise<Set<string> | null>((resolve) => {
    const working = new Set(opts.selected);
    const people = opts.candidates
      .filter((p) => p.id !== opts.excludeId)
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));

    const rowsHtml = people
      .map(
        (p) =>
          `<button type="button" class="pp-row" role="option" data-pid="${escAttr(p.id)}" aria-selected="${working.has(p.id) ? 'true' : 'false'}">
            <span class="pp-check" aria-hidden="true">${working.has(p.id) ? '✓' : ''}</span>
            <span class="pp-name">${escHtml(p.name)}</span>
            ${groupBadge(p.group)}
          </button>`,
      )
      .join('');

    const bodyHtml = `
      <div class="pp">
        <input type="search" class="pp-search" placeholder="חיפוש לפי שם…" aria-label="חיפוש לפי שם" maxlength="30" />
        <div class="pp-list" role="listbox" aria-multiselectable="true">
          ${rowsHtml || `<div class="pp-empty">${escHtml(opts.emptyHint ?? 'אין משתתפים נוספים.')}</div>`}
        </div>
        <div class="pp-search-empty" hidden>לא נמצאו משתתפים</div>
      </div>`;

    const actionsHtml = `
      <span class="pp-count" aria-live="polite">נבחרו: ${working.size}</span>
      <button type="button" class="btn-primary pp-apply">אישור</button>
      <button type="button" class="btn-outline pp-cancel">ביטול</button>`;

    let settled = false;
    const finish = (result: Set<string> | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const sheet = showBottomSheet(bodyHtml, {
      title: opts.title,
      actions: actionsHtml,
      // Fires after ×, Esc, backdrop tap, or swipe-down. If אישור already
      // settled the promise, this is a guarded no-op.
      onClose: () => finish(null),
    });

    // The picker can open on top of another modal (e.g. the participant editor
    // at z-index 1250). A plain bottom sheet sits at 1200, so lift its backdrop
    // above the editor; otherwise it renders hidden behind it.
    sheet.el.parentElement?.classList.add('pp-backdrop');

    const root = sheet.el;
    const countEl = root.querySelector('.pp-count') as HTMLElement;
    const searchEl = root.querySelector('.pp-search') as HTMLInputElement;
    const emptyEl = root.querySelector('.pp-search-empty') as HTMLElement;

    const updateCount = () => {
      countEl.textContent = `נבחרו: ${working.size}`;
    };

    // Toggle membership on row tap — surgical, no list re-render.
    (root.querySelector('.pp-list') as HTMLElement).addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.pp-row');
      if (!row) return;
      const pid = row.dataset.pid;
      if (!pid) return;
      const check = row.querySelector('.pp-check') as HTMLElement;
      if (working.has(pid)) {
        working.delete(pid);
        row.setAttribute('aria-selected', 'false');
        check.textContent = '';
      } else {
        working.add(pid);
        row.setAttribute('aria-selected', 'true');
        check.textContent = '✓';
      }
      updateCount();
    });

    // Name search as a DOM overlay (no re-render; input keeps focus).
    searchEl.addEventListener('input', () => {
      const q = searchEl.value.trim().toLowerCase();
      let visible = 0;
      root.querySelectorAll<HTMLElement>('.pp-row').forEach((row) => {
        const name = row.querySelector('.pp-name')?.textContent?.toLowerCase() ?? '';
        const match = q === '' || name.includes(q);
        row.classList.toggle('pp-hidden', !match);
        if (match) visible++;
      });
      emptyEl.toggleAttribute('hidden', visible > 0 || people.length === 0);
    });

    root.querySelector('.pp-apply')?.addEventListener('click', () => {
      finish(new Set(working));
      sheet.close();
    });
    root.querySelector('.pp-cancel')?.addEventListener('click', () => {
      // onClose resolves null once the close animation completes.
      sheet.close();
    });
  });
}
