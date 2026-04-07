/**
 * Continuity Import — parses and validates a ContinuitySnapshot JSON string,
 * and matches snapshot participants to the new schedule's participant list.
 */

import { Participant } from '../models/types';
import {
  ContinuitySnapshot,
  ContinuityParticipant,
} from '../models/continuity-schema';

// ─── Parse & Validate ───────────────────────────────────────────────────────

/**
 * Parse a JSON string into a validated ContinuitySnapshot.
 * Returns the snapshot on success, or an object with an `error` message.
 */
export function parseContinuitySnapshot(
  json: string,
): ContinuitySnapshot | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { error: 'JSON לא תקין — בדוק את הפורמט.' };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'הנתון חייב להיות אובייקט JSON.' };
  }

  const obj = raw as Record<string, unknown>;

  // Schema version check
  if (obj.schemaVersion !== 1) {
    return { error: `גרסת סכמה לא נתמכת: ${obj.schemaVersion ?? 'חסר'}. נדרשת גרסה 1.` };
  }

  // Required top-level fields
  if (typeof obj.exportedAt !== 'string') {
    return { error: 'שדה "exportedAt" חסר או לא תקין.' };
  }
  if (typeof obj.dayIndex !== 'number' || obj.dayIndex < 1) {
    return { error: 'שדה "dayIndex" חסר או לא תקין (חייב להיות מספר חיובי).' };
  }

  // Day window
  const dw = obj.dayWindow as Record<string, unknown> | undefined;
  if (!dw || typeof dw.start !== 'string' || typeof dw.end !== 'string') {
    return { error: 'שדה "dayWindow" חסר או לא תקין.' };
  }
  if (isNaN(Date.parse(dw.start as string)) || isNaN(Date.parse(dw.end as string))) {
    return { error: 'תאריכים ב-"dayWindow" אינם תקינים.' };
  }

  // Participants array
  if (!Array.isArray(obj.participants)) {
    return { error: 'שדה "participants" חסר או לא תקין (חייב להיות מערך).' };
  }

  for (let i = 0; i < (obj.participants as unknown[]).length; i++) {
    const p = (obj.participants as unknown[])[i];
    const err = validateParticipantEntry(p, i);
    if (err) return { error: err };
  }

  return obj as unknown as ContinuitySnapshot;
}

// ─── Participant Matching ───────────────────────────────────────────────────

/**
 * Match snapshot participants to new schedule participants by exact name.
 *
 * Returns a map from new-participant ID → matched ContinuityParticipant.
 * Participants in the snapshot but absent from the new schedule are ignored.
 * Participants in the new schedule but absent from the snapshot get no entry.
 */
export function matchParticipants(
  snapshot: ContinuitySnapshot,
  newParticipants: Participant[],
): Map<string, ContinuityParticipant> {
  const byName = new Map<string, ContinuityParticipant>();
  for (const cp of snapshot.participants) {
    byName.set(cp.name, cp);
  }

  const result = new Map<string, ContinuityParticipant>();
  for (const p of newParticipants) {
    const match = byName.get(p.name);
    if (match) {
      result.set(p.id, match);
    }
  }
  return result;
}

// ─── Validation Helpers ─────────────────────────────────────────────────────

function validateParticipantEntry(p: unknown, index: number): string | null {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) {
    return `משתתף #${index + 1}: חייב להיות אובייקט.`;
  }
  const obj = p as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    return `משתתף #${index + 1}: שדה "name" חסר או ריק.`;
  }
  if (typeof obj.level !== 'number') {
    return `משתתף "${obj.name ?? index + 1}": שדה "level" חסר או לא תקין.`;
  }
  if (!Array.isArray(obj.certifications)) {
    return `משתתף "${obj.name}": שדה "certifications" חסר או לא תקין.`;
  }
  if (typeof obj.group !== 'string') {
    return `משתתף "${obj.name}": שדה "group" חסר או לא תקין.`;
  }
  if (!Array.isArray(obj.assignments)) {
    return `משתתף "${obj.name}": שדה "assignments" חסר או לא תקין.`;
  }

  for (let j = 0; j < (obj.assignments as unknown[]).length; j++) {
    const err = validateAssignmentEntry((obj.assignments as unknown[])[j], obj.name as string, j);
    if (err) return err;
  }

  return null;
}

function validateAssignmentEntry(a: unknown, participantName: string, index: number): string | null {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) {
    return `${participantName}, שיבוץ #${index + 1}: חייב להיות אובייקט.`;
  }
  const obj = a as Record<string, unknown>;

  if (typeof obj.sourceName !== 'string' && typeof obj.taskType !== 'string') {
    return `${participantName}, שיבוץ #${index + 1}: שדה "sourceName" חסר.`;
  }
  if (typeof obj.taskName !== 'string') {
    return `${participantName}, שיבוץ #${index + 1}: שדה "taskName" חסר.`;
  }

  // timeBlock
  const tb = obj.timeBlock as Record<string, unknown> | undefined;
  if (!tb || typeof tb.start !== 'string' || typeof tb.end !== 'string') {
    return `${participantName}, שיבוץ #${index + 1}: שדה "timeBlock" חסר או לא תקין.`;
  }
  if (isNaN(Date.parse(tb.start as string)) || isNaN(Date.parse(tb.end as string))) {
    return `${participantName}, שיבוץ #${index + 1}: תאריכים ב-"timeBlock" אינם תקינים.`;
  }

  if (typeof obj.blocksConsecutive !== 'boolean') {
    return `${participantName}, שיבוץ #${index + 1}: שדה "blocksConsecutive" חסר.`;
  }
  // restRuleId is optional (string or absent); restRuleDurationHours is optional (number or absent)
  if (obj.restRuleId !== undefined && typeof obj.restRuleId !== 'string') {
    return `${participantName}, שיבוץ #${index + 1}: שדה "restRuleId" לא תקין.`;
  }
  if (typeof obj.isLight !== 'boolean') {
    return `${participantName}, שיבוץ #${index + 1}: שדה "isLight" חסר.`;
  }

  return null;
}
