/**
 * Group name validation rules shared across the participants UI and the
 * participant-set xlsx importer.
 *
 * Extracted from the participants tab so DOM-free modules (importers,
 * validators) can reuse the same rules without dragging UI dependencies.
 */

export const FORBIDDEN_GROUP_PATTERNS = [
  /^new\s*group$/i,
  /^group\s*\w$/i, // "Group A", "Group X", "Group 1"
  /^untitled/i,
  /^default/i,
];

export interface GroupValidation {
  valid: boolean;
  error: string;
}

/**
 * Validates a raw group-name string against forbidden patterns and the
 * existing group list (case-insensitive near-duplicate check).
 *
 * The input is trimmed before validation; callers should pass the raw
 * user-entered value.
 */
export function validateGroupName(raw: string, existingGroups: string[]): GroupValidation {
  const name = raw.trim();
  if (!name) return { valid: false, error: 'קבוצה לא יכולה להיות ריקה.' };
  if (name.length < 2) return { valid: false, error: 'שם קבוצה חייב להכיל לפחות 2 תווים.' };
  for (const pat of FORBIDDEN_GROUP_PATTERNS) {
    if (pat.test(name)) return { valid: false, error: `"${name}" אינו מותר כשם קבוצה.` };
  }
  const lower = name.toLowerCase();
  const dup = existingGroups.find((g) => g.toLowerCase() === lower && g !== name);
  if (dup) return { valid: false, error: `קבוצה דומה "${dup}" כבר קיימת. השתמש בה.` };
  return { valid: true, error: '' };
}
