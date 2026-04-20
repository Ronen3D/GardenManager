import type {
  LoadFormula,
  LoadFormulaComponent,
  LoadFormulaRateRef,
  LoadFormulaSnapshotEntry,
  LoadWindow,
  TaskTemplate,
} from '../../models/types';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function formatWindowLabel(w: LoadWindow): string {
  return `${pad2(w.startHour)}:${pad2(w.startMinute)}\u2013${pad2(w.endHour)}:${pad2(w.endMinute)}`;
}

export function resolveRateValue(tpl: TaskTemplate, ref: LoadFormulaRateRef): { value: number; label: string } | null {
  if (ref.kind === 'base') {
    const value = clamp01(tpl.baseLoadWeight ?? 1);
    return { value, label: 'בסיס' };
  }
  const win = (tpl.loadWindows ?? []).find((w) => w.id === ref.windowId);
  if (!win) return null;
  return { value: clamp01(win.weight), label: `חם ${formatWindowLabel(win)}` };
}

export function buildSnapshot(
  components: LoadFormulaComponent[],
  templates: Map<string, TaskTemplate>,
): LoadFormulaSnapshotEntry[] {
  return components.map((c) => {
    const tpl = templates.get(c.refTemplateId);
    if (!tpl) {
      return {
        templateId: c.refTemplateId,
        templateName: '(נמחק)',
        rate:
          c.refRate.kind === 'base'
            ? { kind: 'base', value: 0 }
            : { kind: 'window', windowId: c.refRate.windowId, windowLabel: '', value: 0 },
        missing: true,
      };
    }
    const resolved = resolveRateValue(tpl, c.refRate);
    const refHadLoadWindows = (tpl.loadWindows ?? []).length > 0;
    if (!resolved) {
      return {
        templateId: tpl.id,
        templateName: tpl.name,
        rate:
          c.refRate.kind === 'base'
            ? { kind: 'base', value: 0 }
            : { kind: 'window', windowId: c.refRate.windowId, windowLabel: '', value: 0 },
        missing: true,
        refHadLoadWindows,
      };
    }
    if (c.refRate.kind === 'base') {
      return {
        templateId: tpl.id,
        templateName: tpl.name,
        rate: { kind: 'base', value: resolved.value },
        refHadLoadWindows,
      };
    }
    return {
      templateId: tpl.id,
      templateName: tpl.name,
      rate: {
        kind: 'window',
        windowId: c.refRate.windowId,
        windowLabel: resolved.label,
        value: resolved.value,
      },
      refHadLoadWindows,
    };
  });
}

export function normalizeTargetHours(targetHours: number | undefined): number {
  const n = typeof targetHours === 'number' && Number.isFinite(targetHours) ? targetHours : 1;
  return n > 0 ? n : 1;
}

/**
 * Per-hour engine value for the target task:
 * `(rhsRaw − lhsExtrasRaw) / targetHours`, clamped to [0..1].
 */
export function computeFormulaValue(
  components: LoadFormulaComponent[],
  snapshot: LoadFormulaSnapshotEntry[],
  targetHours?: number,
  lhsExtras?: LoadFormulaComponent[],
  lhsExtrasSnapshot?: LoadFormulaSnapshotEntry[],
): number {
  const rhsRaw = rawFormulaSum(components, snapshot);
  const lhsRaw = lhsExtras && lhsExtrasSnapshot ? rawFormulaSum(lhsExtras, lhsExtrasSnapshot) : 0;
  return clamp01((rhsRaw - lhsRaw) / normalizeTargetHours(targetHours));
}

/** Raw sum of (hours × rate) across components; ignores targetHours and clamping. */
export function rawFormulaSum(components: LoadFormulaComponent[], snapshot: LoadFormulaSnapshotEntry[]): number {
  let sum = 0;
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    const snap = snapshot[i];
    if (!snap || snap.missing) continue;
    sum += c.hours * snap.rate.value;
  }
  return sum;
}

export interface ValidateOk {
  ok: true;
}
export interface ValidateErr {
  ok: false;
  reason: string;
}
export type ValidateResult = ValidateOk | ValidateErr;

function validateComponent(
  c: LoadFormulaComponent,
  editingTemplateId: string,
  templates: Map<string, TaskTemplate>,
): ValidateResult {
  if (!c.refTemplateId) return { ok: false, reason: 'השמירה מושבתת — בחר משימה להשוואה.' };
  if (c.refTemplateId === editingTemplateId) return { ok: false, reason: 'לא ניתן להפנות משימה לעצמה.' };
  if (!(c.hours > 0)) return { ok: false, reason: 'מספר השעות חייב להיות חיובי.' };
  const tpl = templates.get(c.refTemplateId);
  if (!tpl) return { ok: false, reason: 'אחד הרכיבים מפנה למשימה שנמחקה.' };
  if (c.refRate.kind === 'window') {
    const windowId = c.refRate.windowId;
    const exists = (tpl.loadWindows ?? []).some((w) => w.id === windowId);
    if (!exists) return { ok: false, reason: 'אחד הרכיבים מפנה לחלון חם שנמחק.' };
  }
  return { ok: true };
}

export function validateFormula(
  components: LoadFormulaComponent[],
  editingTemplateId: string,
  templates: Map<string, TaskTemplate>,
  lhsExtras?: LoadFormulaComponent[],
): ValidateResult {
  if (!components.length) return { ok: false, reason: 'נדרש לפחות רכיב אחד.' };
  for (const c of components) {
    const res = validateComponent(c, editingTemplateId, templates);
    if (!res.ok) return res;
  }
  if (lhsExtras) {
    for (const c of lhsExtras) {
      const res = validateComponent(c, editingTemplateId, templates);
      if (!res.ok) return res;
    }
  }
  return { ok: true };
}

export interface StaleInfo {
  stale: boolean;
  entries: { index: number; currentValue: number | null }[];
}

function detectStaleList(
  components: LoadFormulaComponent[],
  snapshot: LoadFormulaSnapshotEntry[] | undefined,
  templates: Map<string, TaskTemplate>,
): StaleInfo {
  const entries: { index: number; currentValue: number | null }[] = [];
  let stale = false;
  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    const snap = snapshot?.[i];
    const tpl = templates.get(c.refTemplateId);
    if (!tpl) {
      entries.push({ index: i, currentValue: null });
      if (!snap?.missing) stale = true;
      continue;
    }
    const resolved = resolveRateValue(tpl, c.refRate);
    if (!resolved) {
      entries.push({ index: i, currentValue: null });
      stale = true;
      continue;
    }
    const snapValue = snap?.rate.value ?? 0;
    const drift = Math.abs(resolved.value - snapValue) > 1e-9;
    if (drift) stale = true;
    entries.push({ index: i, currentValue: resolved.value });
  }
  return { stale, entries };
}

export function detectStale(formula: LoadFormula, templates: Map<string, TaskTemplate>): StaleInfo {
  const rhs = detectStaleList(formula.components, formula.snapshot, templates);
  if (!formula.lhsExtras || !formula.lhsExtras.length) return rhs;
  const lhs = detectStaleList(formula.lhsExtras, formula.lhsExtrasSnapshot, templates);
  return { stale: rhs.stale || lhs.stale, entries: rhs.entries };
}

/** LHS-extras stale info (index-aligned with formula.lhsExtras). */
export function detectLhsExtrasStale(formula: LoadFormula, templates: Map<string, TaskTemplate>): StaleInfo {
  if (!formula.lhsExtras || !formula.lhsExtras.length) return { stale: false, entries: [] };
  return detectStaleList(formula.lhsExtras, formula.lhsExtrasSnapshot, templates);
}

/** Build a fresh LoadFormula from RHS components + optional LHS extras + current templates map. */
export function buildFormula(
  components: LoadFormulaComponent[],
  templates: Map<string, TaskTemplate>,
  targetHours?: number,
  lhsExtras?: LoadFormulaComponent[],
): LoadFormula {
  const snapshot = buildSnapshot(components, templates);
  const normalizedTarget = normalizeTargetHours(targetHours);
  const hasLhs = !!(lhsExtras && lhsExtras.length > 0);
  const lhsExtrasSnapshot = hasLhs ? buildSnapshot(lhsExtras!, templates) : undefined;
  return {
    components: components.map((c) => ({ ...c, refRate: { ...c.refRate } })),
    snapshot,
    computedValue: computeFormulaValue(components, snapshot, normalizedTarget, lhsExtras, lhsExtrasSnapshot),
    computedAt: Date.now(),
    targetHours: normalizedTarget,
    ...(hasLhs
      ? {
          lhsExtras: lhsExtras!.map((c) => ({ ...c, refRate: { ...c.refRate } })),
          lhsExtrasSnapshot,
        }
      : {}),
  };
}
