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

export const GROUP_COLORS: Record<string, string> = {
  'Dept A': '#3498db', 'Dept B': '#e67e22', 'Dept C': '#2ecc71', 'Dept D': '#e74c9b',
};

export const LEVEL_COLORS = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];

// ─── Formatting Helpers ──────────────────────────────────────────────────────

/** Format a Date as HH:MM (24h, en-GB). */
export function fmt(d: Date): string {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Level badge HTML. */
export function levelBadge(level: Level): string {
  return `<span class="badge" style="background:${LEVEL_COLORS[level]}">L${level}</span>`;
}

/** Single certification badge HTML. */
export function certBadge(c: Certification): string {
  const colors: Record<string, string> = { Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b' };
  return `<span class="badge" style="background:${colors[c] || '#7f8c8d'}">${c}</span>`;
}

/** Multiple certification badges (returns dash when empty). */
export function certBadges(certs: Certification[]): string {
  if (certs.length === 0) return '<span class="text-muted">—</span>';
  return certs.map(c => certBadge(c)).join(' ');
}

/** Group badge HTML. */
export function groupBadge(group: string): string {
  const color = GROUP_COLORS[group] || '#7f8c8d';
  return `<span class="badge" style="background:${color}">${group}</span>`;
}

/** Task-type badge HTML. */
export function taskTypeBadge(type: TaskType): string {
  const color = TASK_COLORS[type] || '#7f8c8d';
  return `<span class="badge" style="background:${color}">${type}</span>`;
}
