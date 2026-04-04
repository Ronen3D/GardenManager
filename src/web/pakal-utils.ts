import { PakalDefinition, Participant } from '../models/types';
import { escHtml } from './ui-helpers';

export const HORESH_PAKAL_ID = 'pakal-horesh';

export const DEFAULT_PAKAL_DEFINITIONS: PakalDefinition[] = [
  { id: 'pakal-mag', label: 'מג' },
  { id: 'pakal-negev', label: 'נגב' },
  { id: 'pakal-rahpan', label: 'רחפן' },
  { id: 'pakal-kala', label: 'קלע' },
  { id: 'pakal-matol', label: 'מטול' },
  { id: 'pakal-til-lao', label: 'טיל לאו' },
  { id: HORESH_PAKAL_ID, label: 'חורש' },
  { id: 'pakal-kesher-veshuv', label: 'קשר ושו"ב' },
];

const PAKAL_BADGE_COLORS = ['#1f6feb', '#2da44e', '#bf8700', '#8957e5', '#cf222e', '#0a7ea4'];

function isPakalLike(value: unknown): value is Partial<PakalDefinition> {
  return !!value && typeof value === 'object';
}

export function clonePakalDefinitions(definitions: PakalDefinition[]): PakalDefinition[] {
  return definitions.map(def => ({ ...def }));
}

/** Validate and deduplicate pakal definitions from raw data.
 *  No built-in definitions are force-added — the input is the source of truth. */
export function normalizePakalDefinitions(raw: unknown): PakalDefinition[] {
  const normalized: PakalDefinition[] = [];
  const seen = new Set<string>();

  const add = (candidate: Partial<PakalDefinition>): void => {
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    if (!id || !label || seen.has(id)) return;
    normalized.push({
      id,
      label,
      ...(candidate.deleted ? { deleted: true } : {}),
    });
    seen.add(id);
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (isPakalLike(entry)) add(entry);
    }
  }

  return normalized;
}

export function sanitizePakalIds(raw: unknown, definitions: PakalDefinition[]): string[] {
  if (!Array.isArray(raw)) return [];
  const validIds = new Set(definitions.filter(d => !d.deleted).map(def => def.id));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const id = value.trim();
    if (!id || seen.has(id) || !validIds.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function getEffectivePakalIds(participant: Participant, definitions: PakalDefinition[]): string[] {
  const ids = new Set(sanitizePakalIds(participant.pakalIds || [], definitions));
  return definitions.filter(def => !def.deleted && ids.has(def.id)).map(def => def.id);
}

export function getEffectivePakalDefinitions(participant: Participant, definitions: PakalDefinition[]): PakalDefinition[] {
  const ids = new Set(getEffectivePakalIds(participant, definitions));
  return definitions.filter(def => ids.has(def.id));
}

export function renderPakalBadges(
  participant: Participant,
  definitions: PakalDefinition[],
  emptyLabel = '—',
): string {
  const explicitIds = participant.pakalIds || [];
  if (explicitIds.length === 0) return `<span class="text-muted">${emptyLabel}</span>`;

  const activeDefs = definitions.filter(d => !d.deleted);
  const pakalim = getEffectivePakalDefinitions(participant, definitions);

  // Also show orphan badges for pakal IDs that no longer have an active definition
  const activeIds = new Set(activeDefs.map(d => d.id));
  const orphanIds = explicitIds.filter(id => !activeIds.has(id));
  const orphanBadges = orphanIds.map(id => {
    const tombstone = definitions.find(d => d.id === id && d.deleted);
    const label = tombstone ? tombstone.label : id;
    return `<span class="badge badge-sm badge-orphan pakal-badge">⚠ ${escHtml(label)}</span>`;
  });

  if (pakalim.length === 0 && orphanBadges.length === 0) return `<span class="text-muted">${emptyLabel}</span>`;

  const activeBadges = pakalim.map((def, idx) => {
    const color = PAKAL_BADGE_COLORS[idx % PAKAL_BADGE_COLORS.length];
    return `<span class="badge badge-sm pakal-badge" style="background:${color}">${escHtml(def.label)}</span>`;
  });

  return [...activeBadges, ...orphanBadges].join(' ');
}

export function getPakalLabels(participant: Participant, definitions: PakalDefinition[]): string[] {
  return getEffectivePakalDefinitions(participant, definitions).map(def => def.label);
}
