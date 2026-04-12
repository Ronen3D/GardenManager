/**
 * Shared participant-card renderer.
 *
 * Used by the manual-build warehouse picker and the post-generation
 * swap picker so both flows present the same visual language: name,
 * badges, optional workload bar, optional day-load count, and an
 * optional ineligibility reason overlay.
 */

import type { Participant, ParticipantCapacity } from '../models/types';
import { certBadges, escHtml, groupColor, levelBadge } from './ui-helpers';
import type { WeeklyWorkload } from './workload-utils';

export interface ParticipantCardData {
  participant: Participant;
  /** When false, the card is rendered greyed out with the rejection reason. */
  eligible: boolean;
  /** Hebrew rejection reason text; shown when `eligible === false`. */
  rejectionReason?: string | null;
  /** Weekly workload (effective hours + hot/cold split). */
  workload?: WeeklyWorkload;
  /** Capacity info — used to draw the workload bar fill ratio. */
  capacity?: ParticipantCapacity;
  /** Number of assignments this participant already has on the current day. */
  dayAssignmentCount?: number;
  /**
   * Override for the corner load badge. When provided, takes precedence over
   * `dayAssignmentCount` — callers can use this to surface a different metric
   * (e.g. effective hours in the swap picker, where the list is ordered by
   * that value and the badge should reflect the actual ordering criterion).
   */
  loadBadge?: { text: string; tooltip: string };
  /** Whether this card is the currently selected candidate in the picker. */
  selected?: boolean;
  /** Extra CSS classes to append (callers can pass layout variants). */
  extraClass?: string;
  /** Extra data-* attributes as a pre-rendered string (e.g. `data-trade-id="X"`). */
  extraDataAttrs?: string;
}

/**
 * Render a single participant card as an HTML string. The outer element
 * has `data-pid="<participant.id>"` and `role="button"` so existing click
 * handlers in the warehouse picker continue to work unchanged.
 */
export function renderParticipantCard(data: ParticipantCardData): string {
  const {
    participant: p,
    eligible,
    rejectionReason,
    workload,
    dayAssignmentCount,
    loadBadge,
    selected,
    extraClass,
    extraDataAttrs,
  } = data;

  const classes = ['warehouse-card'];
  classes.push(eligible ? 'wc-eligible' : 'wc-ineligible');
  if (selected) classes.push('wc-selected');
  if (extraClass) classes.push(extraClass);

  const workloadText = workload ? renderWorkloadText(workload) : '';
  const dayBadge = loadBadge
    ? `<span class="wc-load" title="${escHtml(loadBadge.tooltip)}">${escHtml(loadBadge.text)}</span>`
    : dayAssignmentCount && dayAssignmentCount > 0
      ? `<span class="wc-load" title="${dayAssignmentCount} שיבוצים היום">${dayAssignmentCount}</span>`
      : '';
  const reasonOverlay =
    !eligible && rejectionReason
      ? `<div class="wc-reason" title="${escHtml(rejectionReason)}">${escHtml(rejectionReason)}</div>`
      : '';

  return `<div class="${classes.join(' ')}" data-pid="${p.id}" role="button" tabindex="0"${extraDataAttrs ? ` ${extraDataAttrs}` : ''}>
    <div class="wc-row-main">
      <span class="wc-name" style="color:${groupColor(p.group)}">${escHtml(p.name)}</span>
      <span class="wc-badges">${levelBadge(p.level)} ${certBadges(p.certifications, '')}</span>
      ${dayBadge}
    </div>
    ${workloadText ? `<div class="wc-row-workload">${workloadText}</div>` : ''}
    ${reasonOverlay}
  </div>`;
}

/**
 * Render the numeric workload line: effective hours + hot/cold split.
 * Kept compact so it fits inside the card without wrapping.
 */
function renderWorkloadText(workload: WeeklyWorkload): string {
  const eff = workload.effectiveHours.toFixed(1);
  const hot = workload.hotHours.toFixed(1);
  const cold = workload.coldHours.toFixed(1);
  const ratio = workload.loadRatio !== undefined ? ` · ${Math.round(workload.loadRatio * 100)}%` : '';
  return `<span class="wc-workload-text" title="שעות אפקטיביות: ${eff}; חמות: ${hot}; קרות: ${cold}">שע׳: ${eff}${ratio}</span>`;
}
