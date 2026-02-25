/**
 * Shared UI formatting helpers & color maps.
 *
 * Extracted from app.ts and tab-profile.ts (R5) to eliminate duplication
 * and provide a single source of truth for badge rendering and color
 * constants used across the web presentation layer.
 */

import { Level, Certification, TaskType } from '../models/types';

// ─── Color Maps ──────────────────────────────────────────────────────────────

export const TASK_COLORS: Record<string, string> = {
  Adanit: '#4A90D9', Hamama: '#E74C3C', Shemesh: '#F39C12',
  Mamtera: '#27AE60', Karov: '#8E44AD', Karovit: '#BDC3C7', Aruga: '#1ABC9C',
};

/** Dynamic group→color palette (auto-assigned on first access). */
const GROUP_PALETTE = ['#3498db', '#e67e22', '#2ecc71', '#9b59b6', '#e74c3c', '#1abc9c', '#f39c12', '#34495e'];
const _groupColorCache: Record<string, string> = {};

export function groupColor(group: string): string {
  if (!_groupColorCache[group]) {
    const idx = Object.keys(_groupColorCache).length % GROUP_PALETTE.length;
    _groupColorCache[group] = GROUP_PALETTE[idx];
  }
  return _groupColorCache[group];
}

export const LEVEL_COLORS: Record<Level, string> = {
  [Level.L0]: '#95a5a6',
  [Level.L2]: '#2ecc71',
  [Level.L3]: '#e67e22',
  [Level.L4]: '#e74c3c',
};

export const CERT_COLORS: Record<string, string> = {
  Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b', Horesh: '#27ae60',
};

// ─── Formatting Helpers ──────────────────────────────────────────────────────

/** Format a Date as HH:MM (24h, en-GB). */
export function fmt(d: Date): string {
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

/** Level badge HTML. */
export function levelBadge(level: Level): string {
  const labels: Record<Level, string> = { [Level.L0]: 'דרגה 0', [Level.L2]: 'דרגה 2', [Level.L3]: 'דרגה 3', [Level.L4]: 'דרגה 4' };
  return `<span class="badge" style="background:${LEVEL_COLORS[level]}">${labels[level]}</span>`;
}

/** Hebrew labels for certification enum values. */
export const CERT_LABELS: Record<string, string> = { Nitzan: 'ניצן', Salsala: 'סלסלה', Hamama: 'חממה', Horesh: 'חורש' };

/** Hebrew labels for task-type enum values. */
export const TASK_TYPE_LABELS: Record<string, string> = {
  Adanit: 'אדנית', Hamama: 'חממה', Shemesh: 'שמש',
  Mamtera: 'ממטרה', Karov: 'כרוב', Karovit: 'כרובית', Aruga: 'ערוגה',
};

/** Single certification badge HTML. */
export function certBadge(c: Certification): string {
  return `<span class="badge" style="background:${CERT_COLORS[c] || '#7f8c8d'}">${CERT_LABELS[c] || c}</span>`;
}

/** Multiple certification badges (returns dash when empty). */
export function certBadges(certs: Certification[], emptyLabel = '—'): string {
  if (certs.length === 0) return `<span class="text-muted">${emptyLabel}</span>`;
  return certs.map(c => certBadge(c)).join(' ');
}

/** Group badge HTML. Optionally renders as a clickable filter badge. */
export function groupBadge(group: string, clickable = false): string {
  const color = groupColor(group);
  if (clickable) {
    return `<span class="badge badge-group-select" style="background:${color};cursor:pointer" data-select-group="${group}" title="בחר את כל חברי ${group}">${group}</span>`;
  }
  return `<span class="badge" style="background:${color}">${group}</span>`;
}

/** Task-type badge HTML. */
export function taskTypeBadge(type: TaskType): string {
  const color = TASK_COLORS[type] || '#7f8c8d';
  const icons: Record<string, string> = {
    Adanit: '🌱', Hamama: '🏠', Shemesh: '☀️',
    Mamtera: '💧', Karov: '🥬', Karovit: '🥬', Aruga: '🌿',
  };
  const icon = icons[type] || '';
  return `<span class="badge" style="background:${color}">${icon ? `<span aria-hidden="true" style="margin-inline-end:3px">${icon}</span>` : ''}${TASK_TYPE_LABELS[type] || type}</span>`;
}
