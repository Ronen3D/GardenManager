/**
 * Shared UI formatting helpers & color maps.
 *
 * Extracted from app.ts and tab-profile.ts (R5) to eliminate duplication
 * and provide a single source of truth for badge rendering and color
 * constants used across the web presentation layer.
 */

import { Level } from '../models/types';
import { fmtTime, stripTaskNameAffixes } from '../utils/date-utils';
import { getCertColor, getCertificationById, getCertLabel, getTemplateVisualMap } from './config-store';

// ─── SVG Icons ───────────────────────────────────────────────────────────────

export const SVG_ICONS = {
  edit: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  block: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
  moon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  sun: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
  participants: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  tasks: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/></svg>`,
  chart: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`,
  settings: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  calendar: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
  snowflake: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/><line x1="19.07" y1="4.93" x2="4.93" y2="19.07"/></svg>`,
  chevronDown: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
};

// ─── Task Visual Helpers ────────────────────────────────────────────────────

/** Get color for a task-like object. Uses direct color property, falls back to template visual map by sourceName. */
export function getTaskColor(task: { color?: string; sourceName?: string }): string {
  if (task.color) return task.color;
  if (task.sourceName) {
    return getTemplateVisualMap()[task.sourceName]?.color || '#7f8c8d';
  }
  return '#7f8c8d';
}

/** Get label for a task-like object. Uses sourceName (template name). */
export function getTaskLabel(task: { sourceName?: string; name?: string }): string {
  return task.sourceName || task.name || 'משימה';
}

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

// ─── Formatting Helpers ──────────────────────────────────────────────────────

/** Format a Date as HH:MM (24h). Delegates to shared fmtTime. */
export function fmt(d: Date): string {
  return fmtTime(d);
}

/** Level badge HTML. */
export function levelBadge(level: Level): string {
  const labels: Record<Level, string> = {
    [Level.L0]: 'דרגה 0',
    [Level.L2]: 'דרגה 2',
    [Level.L3]: 'דרגה 3',
    [Level.L4]: 'דרגה 4',
  };
  return `<span class="badge" style="background:${LEVEL_COLORS[level]}">${labels[level]}</span>`;
}

/** Single certification badge HTML. Shows orphan warning if cert definition was deleted. */
export function certBadge(c: string): string {
  const def = getCertificationById(c);
  if (!def) {
    return `<span class="badge badge-orphan" title="הסמכה שנמחקה: ${escHtml(c)}">⚠ ${escHtml(c)}</span>`;
  }
  if (def.deleted) {
    return `<span class="badge badge-orphan" title="הסמכה שנמחקה: ${escHtml(def.label)}">⚠ ${escHtml(def.label)}</span>`;
  }
  return `<span class="badge" style="background:${def.color}">${escHtml(def.label)}</span>`;
}

/** Multiple certification badges (returns dash when empty). */
export function certBadges(certs: string[], emptyLabel = '—'): string {
  if (certs.length === 0) return `<span class="text-muted">${emptyLabel}</span>`;
  return certs.map((c) => certBadge(c)).join(' ');
}

/** Group badge HTML. Optionally renders as a clickable filter badge. */
export function groupBadge(group: string, clickable = false): string {
  const color = groupColor(group);
  if (clickable) {
    return `<span class="badge badge-group-select" style="background:${color};cursor:pointer" data-select-group="${group}" title="בחר את כל חברי ${group}">${group}</span>`;
  }
  return `<span class="badge" style="background:${color}">${group}</span>`;
}

/** Task badge HTML from a task-like object with direct visual properties. */
export function taskBadge(task: { color?: string; sourceName?: string; name?: string }): string {
  const color = task.color || '#7f8c8d';
  const label = task.sourceName || (task.name ? stripDayPrefix(task.name) : '');
  return `<span class="badge" style="background:${color}">${label}</span>`;
}

/**
 * Strip the engine-internal `D{N} ` day-index prefix and any trailing numeric
 * `משמרת {N}` suffix from a task name. Times are always rendered separately,
 * so the numeric shift adds noise without information. Descriptive shift
 * labels (e.g. `משמרת בוקר`) are preserved because the trailing token isn't
 * numeric.
 *
 * Prefer `task.sourceName` when you have a `Task` object — this helper is the
 * fallback for transport objects that only carry the decorated `name` string.
 */
export const stripDayPrefix = stripTaskNameAffixes;

/**
 * Strip a trailing `HH:MM–HH:MM` range (hyphen, en-dash, or minus sign) from
 * a user-defined slot label. The UI renders time separately as an aligned
 * LTR tag, so including it inside the label is pure duplication. Anchored to
 * the end of the string, so mid-label time references are preserved.
 */
export function cleanSlotLabel(label: string): string {
  return label.replace(/\s+\d{1,2}:\d{2}\s*[-–−]\s*\d{1,2}:\d{2}\s*$/, '').trim();
}

/** Escape a string for safe HTML interpolation. */
export function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escape a string for safe HTML attribute interpolation. */
export function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Theme Utilities ────────────────────────────────────────────────────────

const THEME_STORAGE_KEY = 'gardenmanager_theme';
const DEFAULT_ATTEMPTS_STORAGE_KEY = 'gardenmanager_default_attempts';
const FALLBACK_DEFAULT_ATTEMPTS = 60;

export function applyTheme(theme: 'dark' | 'light'): void {
  if (theme === 'light') {
    document.documentElement.dataset.theme = 'light';
  } else {
    delete document.documentElement.dataset.theme;
  }
}

export function getStoredTheme(): 'dark' | 'light' {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  const isMobileOrTablet = window.matchMedia?.('(max-width: 1024px)').matches;
  return isMobileOrTablet ? 'light' : 'dark';
}

export function getCurrentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: 'dark' | 'light'): void {
  // Write to localStorage immediately so subsequent renders read the correct value.
  // Swallow quota / access errors so the theme toggle still flips the UI —
  // a missing persisted theme is a far smaller problem than a broken click handler.
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (err) {
    console.warn('[ui-helpers] Failed to persist theme:', err);
  }

  const commitSwitch = () => {
    applyTheme(theme);
  };

  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(commitSwitch);
  } else {
    commitSwitch();
  }
}

// ─── Default Attempts Utilities ─────────────────────────────────────────────

export function getStoredDefaultAttempts(): number {
  const stored = localStorage.getItem(DEFAULT_ATTEMPTS_STORAGE_KEY);
  if (stored !== null) {
    const val = parseInt(stored, 10);
    if (Number.isInteger(val) && val > 0) return val;
  }
  return FALLBACK_DEFAULT_ATTEMPTS;
}

export function setDefaultAttempts(value: number): void {
  try {
    localStorage.setItem(DEFAULT_ATTEMPTS_STORAGE_KEY, String(value));
  } catch (err) {
    console.warn('[ui-helpers] Failed to persist default attempts:', err);
  }
}
