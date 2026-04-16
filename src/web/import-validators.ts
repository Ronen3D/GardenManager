/**
 * Deep payload validators for `.gm.json` import files.
 *
 * Called from `validateImportFile()` in `data-transfer.ts` BEFORE any store
 * mutation occurs.  Each validator checks structural integrity (required fields
 * exist with the correct JS types) — it does NOT validate business semantics
 * such as referential integrity between IDs or value ranges.
 *
 * Every validator returns a Hebrew error string on failure, or `null` on success.
 */

type R = Record<string, unknown>;

// ─── Shared Helpers ────────────────────────────────────────────────────────

function requireString(obj: R, field: string, ctx: string): string | null {
  if (typeof obj[field] !== 'string') return `שדה "${field}" חסר או לא תקין ב-${ctx}.`;
  return null;
}

function requireNumber(obj: R, field: string, ctx: string): string | null {
  if (typeof obj[field] !== 'number') return `שדה "${field}" חסר או לא תקין ב-${ctx}.`;
  return null;
}

function requireBoolean(obj: R, field: string, ctx: string): string | null {
  if (typeof obj[field] !== 'boolean') return `שדה "${field}" חסר או לא תקין ב-${ctx}.`;
  return null;
}

function requireArray(obj: R, field: string, ctx: string): string | null {
  if (!Array.isArray(obj[field])) return `שדה "${field}" חסר או אינו מערך ב-${ctx}.`;
  return null;
}

function requireObject(obj: R, field: string, ctx: string): string | null {
  const v = obj[field];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return `שדה "${field}" חסר או לא תקין ב-${ctx}.`;
  return null;
}

/** Run a list of checks, return the first error or null. */
function firstError(...checks: (string | null)[]): string | null {
  for (const c of checks) if (c) return c;
  return null;
}

// ─── Slot / SubTeam Helpers ────────────────────────────────────────────────

function validateSlotTemplate(slot: R, ctx: string): string | null {
  return firstError(
    requireString(slot, 'id', ctx),
    requireString(slot, 'label', ctx),
    requireArray(slot, 'acceptableLevels', ctx),
    requireArray(slot, 'requiredCertifications', ctx),
  );
}

function validateSlotArray(arr: unknown[], ctx: string): string | null {
  for (let i = 0; i < arr.length; i++) {
    const slot = arr[i];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
      return `איבר #${i + 1} ב-${ctx} אינו אובייקט.`;
    }
    const err = validateSlotTemplate(slot as R, `${ctx} #${i + 1}`);
    if (err) return err;
  }
  return null;
}

function validateSubTeams(arr: unknown[], ctx: string): string | null {
  for (let i = 0; i < arr.length; i++) {
    const st = arr[i];
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
      return `תת-צוות #${i + 1} ב-${ctx} אינו אובייקט.`;
    }
    const stObj = st as R;
    const err = firstError(
      requireString(stObj, 'id', `תת-צוות #${i + 1} ב-${ctx}`),
      requireString(stObj, 'name', `תת-צוות #${i + 1} ב-${ctx}`),
      requireArray(stObj, 'slots', `תת-צוות #${i + 1} ב-${ctx}`),
    );
    if (err) return err;
    const slotErr = validateSlotArray(
      stObj.slots as unknown[],
      `משבצות תת-צוות "${(stObj.name as string) || i + 1}" ב-${ctx}`,
    );
    if (slotErr) return slotErr;
  }
  return null;
}

// ─── AlgorithmSettings (shared) ────────────────────────────────────────────

const SCHEDULER_CONFIG_KEYS = [
  'minRestWeight',
  'l0FairnessWeight',
  'seniorFairnessWeight',
  'maxIterations',
  'maxSolverTimeMs',
  'lowPriorityLevelPenalty',
  'dailyBalanceWeight',
  'notWithPenalty',
  'taskNamePreferencePenalty',
  'taskNameAvoidancePenalty',
  'taskNamePreferenceBonus',
] as const;

function validateAlgorithmSettings(obj: unknown, ctx: string): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return `${ctx} חסר או לא תקין.`;
  }
  const s = obj as R;

  // config
  const configErr = requireObject(s, 'config', ctx);
  if (configErr) return configErr;
  const config = s.config as R;
  for (const key of SCHEDULER_CONFIG_KEYS) {
    const err = requireNumber(config, key, `config ב-${ctx}`);
    if (err) return err;
  }

  // disabledHardConstraints
  const dhcErr = requireArray(s, 'disabledHardConstraints', ctx);
  if (dhcErr) return dhcErr;

  // dayStartHour
  return requireNumber(s, 'dayStartHour', ctx);
}

// ─── Per-Type Validators ───────────────────────────────────────────────────

export function validateAlgorithmPayload(payload: R): string | null {
  // currentSettings
  const settingsErr = validateAlgorithmSettings(payload.currentSettings, 'הגדרות אלגוריתם');
  if (settingsErr) return settingsErr;

  // presets
  const presetsErr = requireArray(payload, 'presets', 'ייצוא אלגוריתם');
  if (presetsErr) return presetsErr;
  const presets = payload.presets as unknown[];
  for (let i = 0; i < presets.length; i++) {
    const p = presets[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return `סט #${i + 1} ב-presets אינו אובייקט.`;
    }
    const pObj = p as R;
    const ctx = `סט #${i + 1}`;
    const err = firstError(
      requireString(pObj, 'id', ctx),
      requireString(pObj, 'name', ctx),
      requireNumber(pObj, 'createdAt', ctx),
    );
    if (err) return err;
    const psErr = validateAlgorithmSettings(pObj.settings, `הגדרות ${ctx}`);
    if (psErr) return psErr;
  }

  return null;
}

export function validateTaskSetPayload(payload: R): string | null {
  const tsErr = requireObject(payload, 'taskSet', 'ייצוא סט משימות');
  if (tsErr) return tsErr;
  const ts = payload.taskSet as R;

  const baseErr = firstError(
    requireString(ts, 'id', 'סט משימות'),
    requireString(ts, 'name', 'סט משימות'),
    requireNumber(ts, 'createdAt', 'סט משימות'),
  );
  if (baseErr) return baseErr;

  // templates
  const tplArrErr = requireArray(ts, 'templates', 'סט משימות');
  if (tplArrErr) return tplArrErr;
  const templates = ts.templates as unknown[];
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return `תבנית #${i + 1} ב-templates אינה אובייקט.`;
    }
    const tObj = t as R;
    const ctx = `תבנית "${(tObj.name as string) || i + 1}"`;
    const err = firstError(
      requireString(tObj, 'id', ctx),
      requireString(tObj, 'name', ctx),
      requireNumber(tObj, 'durationHours', ctx),
      requireNumber(tObj, 'shiftsPerDay', ctx),
      requireNumber(tObj, 'startHour', ctx),
      requireArray(tObj, 'slots', ctx),
      requireArray(tObj, 'subTeams', ctx),
    );
    if (err) return err;
    const slotErr = validateSlotArray(tObj.slots as unknown[], `משבצות ${ctx}`);
    if (slotErr) return slotErr;
    const stErr = validateSubTeams(tObj.subTeams as unknown[], ctx);
    if (stErr) return stErr;
  }

  // oneTimeTasks
  const otArrErr = requireArray(ts, 'oneTimeTasks', 'סט משימות');
  if (otArrErr) return otArrErr;
  const ots = ts.oneTimeTasks as unknown[];
  for (let i = 0; i < ots.length; i++) {
    const ot = ots[i];
    if (!ot || typeof ot !== 'object' || Array.isArray(ot)) {
      return `משימה חד-פעמית #${i + 1} אינה אובייקט.`;
    }
    const otObj = ot as R;
    const ctx = `משימה חד-פעמית "${(otObj.name as string) || i + 1}"`;
    // scheduledDate can be a Date object or an ISO string after deserialization
    if (otObj.scheduledDate == null) {
      return `שדה "scheduledDate" חסר ב-${ctx}.`;
    }
    const err = firstError(
      requireString(otObj, 'id', ctx),
      requireString(otObj, 'name', ctx),
      requireNumber(otObj, 'startHour', ctx),
      requireNumber(otObj, 'durationHours', ctx),
      requireArray(otObj, 'slots', ctx),
      requireArray(otObj, 'subTeams', ctx),
    );
    if (err) return err;
    const slotErr = validateSlotArray(otObj.slots as unknown[], `משבצות ${ctx}`);
    if (slotErr) return slotErr;
    const stErr = validateSubTeams(otObj.subTeams as unknown[], ctx);
    if (stErr) return stErr;
  }

  // restRules
  const rrArrErr = requireArray(ts, 'restRules', 'סט משימות');
  if (rrArrErr) return rrArrErr;
  const rrs = ts.restRules as unknown[];
  for (let i = 0; i < rrs.length; i++) {
    const rr = rrs[i];
    if (!rr || typeof rr !== 'object' || Array.isArray(rr)) {
      return `כלל מנוחה #${i + 1} אינו אובייקט.`;
    }
    const rrObj = rr as R;
    const err = firstError(
      requireString(rrObj, 'id', `כלל מנוחה #${i + 1}`),
      requireString(rrObj, 'label', `כלל מנוחה #${i + 1}`),
      requireNumber(rrObj, 'durationHours', `כלל מנוחה #${i + 1}`),
    );
    if (err) return err;
  }

  return null;
}

export function validateParticipantSetPayload(payload: R): string | null {
  const psErr = requireObject(payload, 'participantSet', 'ייצוא סט משתתפים');
  if (psErr) return psErr;
  const ps = payload.participantSet as R;

  const baseErr = firstError(
    requireString(ps, 'id', 'סט משתתפים'),
    requireString(ps, 'name', 'סט משתתפים'),
    requireNumber(ps, 'createdAt', 'סט משתתפים'),
  );
  if (baseErr) return baseErr;

  // participants
  const pArrErr = requireArray(ps, 'participants', 'סט משתתפים');
  if (pArrErr) return pArrErr;
  const participants = ps.participants as unknown[];
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return `משתתף #${i + 1} אינו אובייקט.`;
    }
    const pObj = p as R;
    const ctx = `משתתף "${(pObj.name as string) || i + 1}"`;
    const err = firstError(
      requireString(pObj, 'name', ctx),
      requireNumber(pObj, 'level', ctx),
      requireArray(pObj, 'certifications', ctx),
      requireString(pObj, 'group', ctx),
      requireArray(pObj, 'dateUnavailability', ctx),
    );
    if (err) return err;
  }

  // certificationCatalog
  const ccErr = requireArray(ps, 'certificationCatalog', 'סט משתתפים');
  if (ccErr) return ccErr;
  const certs = ps.certificationCatalog as unknown[];
  for (let i = 0; i < certs.length; i++) {
    const c = certs[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return `הסמכה #${i + 1} ב-certificationCatalog אינה אובייקט.`;
    }
    const cObj = c as R;
    const err = firstError(
      requireString(cObj, 'id', `הסמכה #${i + 1}`),
      requireString(cObj, 'label', `הסמכה #${i + 1}`),
      requireString(cObj, 'color', `הסמכה #${i + 1}`),
    );
    if (err) return err;
  }

  return null;
}

export function validateScheduleSnapshotPayload(payload: R): string | null {
  const snapErr = requireObject(payload, 'snapshot', 'ייצוא תמונת מצב');
  if (snapErr) return snapErr;
  const snap = payload.snapshot as R;

  const baseErr = firstError(
    requireString(snap, 'id', 'תמונת מצב'),
    requireString(snap, 'name', 'תמונת מצב'),
    requireNumber(snap, 'createdAt', 'תמונת מצב'),
  );
  if (baseErr) return baseErr;

  // schedule
  const schedErr = requireObject(snap, 'schedule', 'תמונת מצב');
  if (schedErr) return schedErr;
  const sched = snap.schedule as R;

  const schedFieldsErr = firstError(
    requireArray(sched, 'tasks', 'שבצ"ק'),
    requireArray(sched, 'participants', 'שבצ"ק'),
    requireArray(sched, 'assignments', 'שבצ"ק'),
    requireBoolean(sched, 'feasible', 'שבצ"ק'),
    requireObject(sched, 'score', 'שבצ"ק'),
    requireArray(sched, 'violations', 'שבצ"ק'),
  );
  if (schedFieldsErr) return schedFieldsErr;

  // Validate task items have minimal structure
  const tasks = sched.tasks as unknown[];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      return `משימה #${i + 1} ב-שבצ"ק אינה אובייקט.`;
    }
    const tObj = t as R;
    const err = firstError(
      requireString(tObj, 'id', `משימה #${i + 1} בשבצ"ק`),
      requireString(tObj, 'name', `משימה #${i + 1} בשבצ"ק`),
      requireArray(tObj, 'slots', `משימה #${i + 1} בשבצ"ק`),
    );
    if (err) return err;
  }

  // Validate participant items
  const parts = sched.participants as unknown[];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      return `משתתף #${i + 1} ב-שבצ"ק אינו אובייקט.`;
    }
    const pObj = p as R;
    const err = firstError(
      requireString(pObj, 'id', `משתתף #${i + 1} בשבצ"ק`),
      requireString(pObj, 'name', `משתתף #${i + 1} בשבצ"ק`),
    );
    if (err) return err;
  }

  // Optional certification/pakal catalogs — validate shape if present
  if (payload.certificationCatalog != null) {
    if (!Array.isArray(payload.certificationCatalog)) {
      return 'שדה "certificationCatalog" אינו מערך ב-ייצוא תמונת מצב.';
    }
    const certs = payload.certificationCatalog as unknown[];
    for (let i = 0; i < certs.length; i++) {
      const c = certs[i];
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        return `הסמכה #${i + 1} ב-certificationCatalog אינה אובייקט.`;
      }
      const cObj = c as R;
      const err = firstError(
        requireString(cObj, 'id', `הסמכה #${i + 1}`),
        requireString(cObj, 'label', `הסמכה #${i + 1}`),
      );
      if (err) return err;
    }
  }

  if (payload.pakalCatalog != null) {
    if (!Array.isArray(payload.pakalCatalog)) {
      return 'שדה "pakalCatalog" אינו מערך ב-ייצוא תמונת מצב.';
    }
    const pakals = payload.pakalCatalog as unknown[];
    for (let i = 0; i < pakals.length; i++) {
      const p = pakals[i];
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        return `פק"ל #${i + 1} ב-pakalCatalog אינו אובייקט.`;
      }
      const pObj = p as R;
      const err = firstError(
        requireString(pObj, 'id', `פק"ל #${i + 1}`),
        requireString(pObj, 'label', `פק"ל #${i + 1}`),
      );
      if (err) return err;
    }
  }

  return null;
}

export function validateFullBackupPayload(payload: R): string | null {
  const seErr = requireObject(payload, 'storageEntries', 'גיבוי מלא');
  if (seErr) return seErr;
  const entries = payload.storageEntries as R;

  // Must contain the main state key — otherwise it's not a real backup
  if (!('gardenmanager_state' in entries)) {
    return 'גיבוי חסר מפתח "gardenmanager_state" — ייתכן שהקובץ חלקי או פגום.';
  }

  // Validate all values are strings and parseable JSON
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value !== 'string') {
      return `ערך עבור מפתח "${key}" בגיבוי אינו מחרוזת.`;
    }
    try {
      JSON.parse(value);
    } catch {
      return `ערך עבור מפתח "${key}" בגיבוי אינו JSON תקין — ייתכן שהקובץ נקטע.`;
    }
  }

  // The state entry must parse to a non-null object
  try {
    const state = JSON.parse(entries.gardenmanager_state as string);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return 'מפתח "gardenmanager_state" בגיבוי אינו אובייקט תקין.';
    }
  } catch {
    // Already caught above, but guard defensively
    return 'מפתח "gardenmanager_state" בגיבוי אינו JSON תקין.';
  }

  return null;
}
