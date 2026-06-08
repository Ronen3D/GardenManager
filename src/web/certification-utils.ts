import type { CertificationDefinition } from '../models/types';

function isCertLike(value: unknown): value is Partial<CertificationDefinition> {
  return !!value && typeof value === 'object';
}

/** Validate and deduplicate certification definitions from raw data.
 *  No built-in definitions are force-added — the input is the source of truth. */
export function normalizeCertificationDefinitions(raw: unknown): CertificationDefinition[] {
  const normalized: CertificationDefinition[] = [];
  const seen = new Set<string>();

  const add = (candidate: Partial<CertificationDefinition>): void => {
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const color = typeof candidate.color === 'string' ? candidate.color.trim() : '#7f8c8d';
    if (!id || !label || seen.has(id)) return;
    normalized.push({
      id,
      label,
      color,
      ...(candidate.deleted ? { deleted: true } : {}),
    });
    seen.add(id);
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (isCertLike(entry)) add(entry);
    }
  }

  return normalized;
}
