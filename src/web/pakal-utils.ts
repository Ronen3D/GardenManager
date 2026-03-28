import { Certification, PakalDefinition, Participant } from '../models/types';
import { escHtml } from './ui-helpers';

export const HORESH_PAKAL_ID = 'pakal-horesh';

export const BUILTIN_PAKAL_DEFINITIONS: PakalDefinition[] = [
  { id: 'pakal-mag', label: 'מג', builtIn: true },
  { id: 'pakal-negev', label: 'נגב', builtIn: true },
  { id: 'pakal-rahpan', label: 'רחפן', builtIn: true },
  { id: 'pakal-kala', label: 'קלע', builtIn: true },
  { id: 'pakal-matol', label: 'מטול', builtIn: true },
  { id: 'pakal-til-lao', label: 'טיל לאו', builtIn: true },
  { id: HORESH_PAKAL_ID, label: 'חורש', builtIn: true },
  { id: 'pakal-kesher-veshuv', label: 'קשר ושו"ב', builtIn: true },
];

const PAKAL_BADGE_COLORS = ['#1f6feb', '#2da44e', '#bf8700', '#8957e5', '#cf222e', '#0a7ea4'];

function isPakalLike(value: unknown): value is Partial<PakalDefinition> {
  return !!value && typeof value === 'object';
}

export function clonePakalDefinitions(definitions: PakalDefinition[]): PakalDefinition[] {
  return definitions.map(def => ({ ...def }));
}

export function normalizePakalDefinitions(raw: unknown): PakalDefinition[] {
  const normalized: PakalDefinition[] = [];
  const seen = new Set<string>();

  const add = (candidate: Partial<PakalDefinition>, forceBuiltIn = false): void => {
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    if (!id || !label || seen.has(id)) return;
    normalized.push({
      id,
      label,
      builtIn: forceBuiltIn || !!candidate.builtIn,
    });
    seen.add(id);
  };

  for (const builtIn of BUILTIN_PAKAL_DEFINITIONS) add(builtIn, true);

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (isPakalLike(entry)) add(entry);
    }
  }

  return normalized;
}

export function sanitizePakalIds(raw: unknown, definitions: PakalDefinition[]): string[] {
  if (!Array.isArray(raw)) return [];
  const validIds = new Set(definitions.map(def => def.id));
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
  if (participant.certifications.includes(Certification.Horesh)) {
    ids.add(HORESH_PAKAL_ID);
  }
  return definitions.filter(def => ids.has(def.id)).map(def => def.id);
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
  const pakalim = getEffectivePakalDefinitions(participant, definitions);
  if (pakalim.length === 0) return `<span class="text-muted">${emptyLabel}</span>`;
  return pakalim.map((def, idx) => {
    const color = PAKAL_BADGE_COLORS[idx % PAKAL_BADGE_COLORS.length];
    return `<span class="badge badge-sm pakal-badge" style="background:${color}">${escHtml(def.label)}</span>`;
  }).join(' ');
}

export function getPakalLabels(participant: Participant, definitions: PakalDefinition[]): string[] {
  return getEffectivePakalDefinitions(participant, definitions).map(def => def.label);
}
