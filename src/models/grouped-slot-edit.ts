/**
 * Grouped slot editing — pure core.
 *
 * Computes the aggregate state of a group of slots for each editable field and
 * applies an add/remove-by-key patch that NEVER touches fields left in the
 * "mixed" state. Dependency-free (type-only imports) so it is unit-testable
 * from `src/test.ts` and importable from both the Node and web builds.
 *
 * The grouped editor lets the user change `acceptableLevels`,
 * `requiredCertifications` and `forbiddenCertifications` across every slot in a
 * scope at once, while preserving legitimate per-slot differences: any control
 * left MIXED is omitted from the patch and each slot keeps its own value.
 */

import type { Level, LevelEntry, SlotTemplate } from './types';

/** State of a single level control across the group. */
export type LevelCtl = 'off' | 'normal' | 'low' | 'mixed';
/** State of a single certification control across the group. */
export type CertCtl = 'on' | 'off' | 'mixed';

/** Which certification list a cert aggregate/patch refers to. */
export type CertKind = 'required' | 'forbidden';

/**
 * A grouped edit. A key being absent from a map means that control is MIXED —
 * the corresponding per-slot value is left untouched.
 */
export interface GroupedSlotEdit {
  /** Per-level target. Absent key ⇒ MIXED (leave each slot as-is). */
  levels: Map<Level, 'off' | 'normal' | 'low'>;
  /** Per-cert: true = ensure present on every slot, false = ensure absent. Absent ⇒ MIXED. */
  requiredCerts: Map<string, boolean>;
  /** Per-cert: true = ensure present on every slot, false = ensure absent. Absent ⇒ MIXED. */
  forbiddenCerts: Map<string, boolean>;
}

/** Reason a slot cannot accept the grouped patch. */
export type GroupedConflictReason = 'EMPTY_LEVELS' | 'CERT_OVERLAP';

export interface GroupedConflict {
  slotId: string;
  label: string;
  reason: GroupedConflictReason;
  /** For CERT_OVERLAP: the cert ids that would be both required and forbidden. */
  certs?: string[];
}

export interface GroupedApplyResult {
  ok: boolean;
  /** Number of slots whose value would actually change (only meaningful when ok). */
  changed: number;
  offending: GroupedConflict[];
}

/** Concrete state of one level on one slot. */
function slotLevelState(slot: SlotTemplate, level: Level): 'off' | 'normal' | 'low' {
  const e = slot.acceptableLevels.find((x) => x.level === level);
  if (!e) return 'off';
  return e.lowPriority ? 'low' : 'normal';
}

/**
 * Aggregate of one level across the group: the uniform state if every slot
 * agrees, otherwise 'mixed'. An empty group is 'mixed' (no concrete value).
 * `normal` and `low` are distinct concrete states, so a level that is normal
 * in some slots and low in others aggregates to 'mixed' (never flattened).
 */
export function computeLevelAggregate(slots: SlotTemplate[], level: Level): LevelCtl {
  if (slots.length === 0) return 'mixed';
  const first = slotLevelState(slots[0], level);
  for (let i = 1; i < slots.length; i++) {
    if (slotLevelState(slots[i], level) !== first) return 'mixed';
  }
  return first;
}

function certList(slot: SlotTemplate, kind: CertKind): string[] {
  return kind === 'required' ? slot.requiredCertifications : (slot.forbiddenCertifications ?? []);
}

/**
 * Aggregate of one cert across the group: 'on' if present on every slot, 'off'
 * if present on none, 'mixed' otherwise (and for an empty group).
 */
export function computeCertAggregate(slots: SlotTemplate[], certId: string, kind: CertKind): CertCtl {
  if (slots.length === 0) return 'mixed';
  let present = 0;
  for (const s of slots) {
    if (certList(s, kind).includes(certId)) present++;
  }
  if (present === 0) return 'off';
  if (present === slots.length) return 'on';
  return 'mixed';
}

/**
 * Apply a grouped patch to a single slot. PURE — returns a new SlotTemplate and
 * never mutates the input. `label` is copied verbatim (never grouped-edited).
 * Cert toggles are add/remove BY KEY, so cert ids that are not in the patch
 * (e.g. orphaned/deleted certs already on the slot) are preserved untouched.
 * Level entries are replaced in place when present to keep ordering stable.
 */
export function applyGroupedPatchToSlot(slot: SlotTemplate, patch: GroupedSlotEdit): SlotTemplate {
  const levels: LevelEntry[] = slot.acceptableLevels.map((e) => ({ ...e }));
  for (const [lvl, st] of patch.levels) {
    const idx = levels.findIndex((e) => e.level === lvl);
    if (st === 'off') {
      if (idx !== -1) levels.splice(idx, 1);
    } else {
      const entry: LevelEntry = st === 'low' ? { level: lvl, lowPriority: true } : { level: lvl };
      if (idx !== -1) levels[idx] = entry;
      else levels.push(entry);
    }
  }

  const req = [...slot.requiredCertifications];
  for (const [c, on] of patch.requiredCerts) {
    const at = req.indexOf(c);
    if (on && at === -1) req.push(c);
    else if (!on && at !== -1) req.splice(at, 1);
  }

  const forb = [...(slot.forbiddenCertifications ?? [])];
  for (const [c, on] of patch.forbiddenCerts) {
    const at = forb.indexOf(c);
    if (on && at === -1) forb.push(c);
    else if (!on && at !== -1) forb.splice(at, 1);
  }

  return {
    id: slot.id,
    label: slot.label,
    acceptableLevels: levels,
    requiredCertifications: req,
    forbiddenCertifications: forb.length ? forb : undefined,
  };
}

/** Order-insensitive canonical key for a slot's editable fields. */
function slotKey(s: SlotTemplate): string {
  const lv = s.acceptableLevels
    .map((e) => `${e.level}${e.lowPriority ? 'L' : 'N'}`)
    .sort()
    .join(',');
  const rq = [...s.requiredCertifications].sort().join(',');
  const fb = [...(s.forbiddenCertifications ?? [])].sort().join(',');
  return `${lv}|${rq}|${fb}`;
}

/**
 * Dry-run the patch over every slot. Flags conflicts WITHOUT mutating:
 *  - EMPTY_LEVELS: a slot would end with zero acceptable levels.
 *  - CERT_OVERLAP: a slot would have a cert both required and forbidden.
 * These mirror the per-slot form invariants in `readSlotFormFields`. `changed`
 * counts only slots whose canonical value actually differs.
 */
export function validateGroupedApply(slots: SlotTemplate[], patch: GroupedSlotEdit): GroupedApplyResult {
  const offending: GroupedConflict[] = [];
  let changed = 0;
  for (const slot of slots) {
    const next = applyGroupedPatchToSlot(slot, patch);
    if (next.acceptableLevels.length === 0) {
      offending.push({ slotId: slot.id, label: slot.label, reason: 'EMPTY_LEVELS' });
      continue;
    }
    const forb = next.forbiddenCertifications ?? [];
    const overlap = next.requiredCertifications.filter((c) => forb.includes(c));
    if (overlap.length) {
      offending.push({ slotId: slot.id, label: slot.label, reason: 'CERT_OVERLAP', certs: overlap });
      continue;
    }
    if (slotKey(next) !== slotKey(slot)) changed++;
  }
  return { ok: offending.length === 0, changed, offending };
}
