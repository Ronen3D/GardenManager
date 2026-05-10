/**
 * Preflight Core — pure feasibility checks shared between Node tests and the
 * web UI. The web entry point in `src/web/preflight.ts` wraps this with
 * config-store getters; tests call `runPreflightWithInputs` directly.
 *
 * Findings are partitioned into Critical (block generation) and Warning
 * (advisory). Each finding is gated by the user's `disabledHardConstraints`
 * so that we never re-impose a globally-disabled constraint indirectly —
 * see CLAUDE.md "feasibility prechecks must respect the same set".
 */

import { findMaxMatching, type SlotCandidates } from '../constraints/group-matching';
import {
  type HardConstraintCode,
  type OneTimeTask,
  type Participant,
  type PreflightFinding,
  type PreflightResult,
  PreflightSeverity,
  type RestRule,
  type SlotTemplate,
  type TaskTemplate,
} from '../models/types';
import { computeAllCapacities } from '../utils/capacity';
import {
  generateShiftBlocks,
  hourInOpDay,
  isBlockedByDateUnavailability,
  isFullyCovered,
  type ScheduleContext,
} from './utils/time-utils';

// ─── Context ─────────────────────────────────────────────────────────────────

export interface PreflightContext {
  participants: Participant[];
  templates: TaskTemplate[];
  oneTimeTasks: OneTimeTask[];
  scheduleStart: Date;
  numDays: number;
  dayStartHour: number;
  disabledHC: Set<string>;
  restRuleLookup: (id: string) => RestRule | undefined;
  certLabel: (id: string) => string;
  scheduleCtx: ScheduleContext;
}

function isDisabled(ctx: PreflightContext, code: HardConstraintCode): boolean {
  return ctx.disabledHC.has(code);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function participantMatchesSlot(p: Participant, slot: SlotTemplate, ctx: PreflightContext): boolean {
  // HC-1: Level
  if (!isDisabled(ctx, 'HC-1')) {
    if (!slot.acceptableLevels.some((e) => e.level === p.level)) return false;
  }
  // HC-2: Required certifications
  if (!isDisabled(ctx, 'HC-2')) {
    for (const cert of slot.requiredCertifications) {
      if (!p.certifications.includes(cert)) return false;
    }
  }
  // HC-11: Forbidden certifications
  if (!isDisabled(ctx, 'HC-11') && slot.forbiddenCertifications) {
    for (const cert of slot.forbiddenCertifications) {
      if (p.certifications.includes(cert)) return false;
    }
  }
  return true;
}

function participantAvailableForBlock(
  p: Participant,
  block: { start: Date; end: Date },
  ctx: PreflightContext,
): boolean {
  if (isDisabled(ctx, 'HC-3')) return true;
  if (!isFullyCovered(block, p.availability)) return false;
  if (isBlockedByDateUnavailability(block, p.dateUnavailability, ctx.scheduleCtx)) return false;
  return true;
}

function collectAllSlots(tpl: TaskTemplate | OneTimeTask): SlotTemplate[] {
  const all: SlotTemplate[] = [...tpl.slots];
  for (const st of tpl.subTeams) all.push(...st.slots);
  return all;
}

function totalSlotsPerShift(tpl: TaskTemplate): number {
  return collectAllSlots(tpl).length;
}

function describeSkillRequirement(slot: SlotTemplate, certLabel: (id: string) => string): string {
  const levelStr = slot.acceptableLevels.map((l) => `דרגה ${l.level}`).join('/');
  const reqStr =
    slot.requiredCertifications.length > 0 ? ` + ${slot.requiredCertifications.map(certLabel).join(', ')}` : '';
  const forbidStr =
    slot.forbiddenCertifications && slot.forbiddenCertifications.length > 0
      ? ` (ללא ${slot.forbiddenCertifications.map(certLabel).join(', ')})`
      : '';
  return `${levelStr}${reqStr}${forbidStr}`;
}

// ─── Skill Gap (aggregate, level + cert only) ────────────────────────────────

function checkSkillGaps(ctx: PreflightContext): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  if (isDisabled(ctx, 'HC-1') && isDisabled(ctx, 'HC-2') && isDisabled(ctx, 'HC-11')) {
    return findings;
  }

  for (const tpl of ctx.templates) {
    for (const slot of collectAllSlots(tpl)) {
      const eligible = ctx.participants.filter((p) => participantMatchesSlot(p, slot, ctx));
      if (eligible.length === 0) {
        findings.push({
          severity: PreflightSeverity.Critical,
          code: 'SKILL_GAP',
          message: `אין משתתפים שמתאימים לדרישה ${describeSkillRequirement(slot, ctx.certLabel)} עבור המשימה "${tpl.name}" במשבצת "${slot.label || tpl.name}".`,
          templateId: tpl.id,
          slotId: slot.id,
        });
      } else if (eligible.length === 1) {
        findings.push({
          severity: PreflightSeverity.Warning,
          code: 'SKILL_SCARCITY',
          message: `רק משתתף אחד יכול לאייש את המשבצת "${slot.label || tpl.name}" במשימה "${tpl.name}" (${eligible[0].name}). אין כרגע חלופה זמינה.`,
          templateId: tpl.id,
          slotId: slot.id,
        });
      }
    }
  }

  for (const ot of ctx.oneTimeTasks) {
    for (const slot of collectAllSlots(ot)) {
      const eligible = ctx.participants.filter((p) => participantMatchesSlot(p, slot, ctx));
      if (eligible.length === 0) {
        findings.push({
          severity: PreflightSeverity.Critical,
          code: 'SKILL_GAP',
          message: `אין משתתפים שמתאימים לדרישה ${describeSkillRequirement(slot, ctx.certLabel)} עבור המשימה החד-פעמית "${ot.name}" במשבצת "${slot.label || ot.name}".`,
          oneTimeTaskId: ot.id,
        });
      } else if (eligible.length === 1) {
        findings.push({
          severity: PreflightSeverity.Warning,
          code: 'SKILL_SCARCITY',
          message: `רק משתתף אחד יכול לאייש את המשבצת "${slot.label || ot.name}" במשימה החד-פעמית "${ot.name}" (${eligible[0].name}).`,
          oneTimeTaskId: ot.id,
        });
      }
    }
  }

  return findings;
}

// ─── Per-(shift × day) Availability Skill Gap ────────────────────────────────

function checkPerShiftAvailability(ctx: PreflightContext): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  if (isDisabled(ctx, 'HC-3')) return findings;

  const baseDate = ctx.scheduleStart;
  const dsh = ctx.dayStartHour;

  const findGapsForBlock = (
    slots: SlotTemplate[],
    block: { start: Date; end: Date },
  ): { zeroAvailableSlots: string[] } => {
    const zeroAvailableSlots: string[] = [];
    for (const slot of slots) {
      const skillEligible = ctx.participants.filter((p) => participantMatchesSlot(p, slot, ctx));
      if (skillEligible.length === 0) continue; // covered by aggregate SKILL_GAP
      const anyAvailable = skillEligible.some((p) => participantAvailableForBlock(p, block, ctx));
      if (!anyAvailable) zeroAvailableSlots.push(slot.label || '—');
    }
    return { zeroAvailableSlots };
  };

  for (const tpl of ctx.templates) {
    if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) continue;
    const slots = collectAllSlots(tpl);
    if (slots.length === 0) continue;

    for (let dayIdx = 1; dayIdx <= ctx.numDays; dayIdx++) {
      const startMs = hourInOpDay(baseDate, dsh, dayIdx, tpl.startHour);
      const startDate = new Date(startMs);
      const shifts =
        tpl.shiftsPerDay === 1
          ? [{ start: startDate, end: new Date(startMs + tpl.durationHours * 3600000) }]
          : generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);

      for (let si = 0; si < shifts.length; si++) {
        const { zeroAvailableSlots } = findGapsForBlock(slots, shifts[si]);
        if (zeroAvailableSlots.length === 0) continue;
        const shiftLabel = tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : '';
        const slotList = zeroAvailableSlots.join(', ');
        findings.push({
          severity: PreflightSeverity.Critical,
          code: 'SHIFT_SKILL_GAP',
          message: `אין משתתפים זמינים למשבצות [${slotList}] במשימה "${tpl.name}"${shiftLabel} ביום ${dayIdx}.`,
          templateId: tpl.id,
        });
      }
    }
  }

  const winStart = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  for (const ot of ctx.oneTimeTasks) {
    if (ot.durationHours <= 0) continue;
    const slots = collectAllSlots(ot);
    if (slots.length === 0) continue;

    const otDay = new Date(ot.scheduledDate.getFullYear(), ot.scheduledDate.getMonth(), ot.scheduledDate.getDate());
    const dayIdx = Math.round((otDay.getTime() - winStart.getTime()) / 86400000) + 1;
    if (dayIdx < 1 || dayIdx > ctx.numDays) continue;

    const startMs = hourInOpDay(baseDate, dsh, dayIdx, ot.startHour) + (ot.startMinute || 0) * 60_000;
    const block = { start: new Date(startMs), end: new Date(startMs + ot.durationHours * 3600000) };
    const { zeroAvailableSlots } = findGapsForBlock(slots, block);
    if (zeroAvailableSlots.length === 0) continue;
    findings.push({
      severity: PreflightSeverity.Critical,
      code: 'SHIFT_SKILL_GAP',
      message: `אין משתתפים זמינים למשבצות [${zeroAvailableSlots.join(', ')}] במשימה החד-פעמית "${ot.name}" ביום ${dayIdx}.`,
      oneTimeTaskId: ot.id,
    });
  }

  return findings;
}

// ─── Capacity ────────────────────────────────────────────────────────────────

interface CapacityResult {
  findings: PreflightFinding[];
  totalRequiredSlots: number;
  totalAvailableParticipantHours: number;
  totalRequiredHours: number;
  utilizationPercent: number;
}

function checkCapacity(ctx: PreflightContext): CapacityResult {
  const findings: PreflightFinding[] = [];

  let totalRequiredHours = 0;
  let totalRequiredSlots = 0;
  for (const tpl of ctx.templates) {
    if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) continue;
    const slotsPerShift = totalSlotsPerShift(tpl);
    const hoursPerSlot = tpl.durationHours * tpl.shiftsPerDay;
    totalRequiredHours += slotsPerShift * hoursPerSlot * ctx.numDays;
    totalRequiredSlots += slotsPerShift * tpl.shiftsPerDay * ctx.numDays;
  }

  for (const ot of ctx.oneTimeTasks) {
    if (ot.durationHours <= 0) continue;
    const slotsCount = collectAllSlots(ot).length;
    totalRequiredHours += slotsCount * ot.durationHours;
    totalRequiredSlots += slotsCount;
  }

  const scheduleStart = ctx.scheduleStart;
  const scheduleEnd = new Date(scheduleStart);
  scheduleEnd.setDate(scheduleEnd.getDate() + ctx.numDays);
  const capacities = computeAllCapacities(ctx.participants, scheduleStart, scheduleEnd, ctx.dayStartHour);
  let totalAvailableParticipantHours = 0;
  for (const cap of capacities.values()) totalAvailableParticipantHours += cap.totalAvailableHours;

  const utilizationPercent =
    totalAvailableParticipantHours > 0 ? (totalRequiredHours / totalAvailableParticipantHours) * 100 : 100;

  if (utilizationPercent > 100) {
    findings.push({
      severity: PreflightSeverity.Critical,
      code: 'CAPACITY_EXCEEDED',
      message: `שעות נדרשות (${totalRequiredHours.toFixed(0)} שע') חורגות מהשעות הזמינות (${totalAvailableParticipantHours.toFixed(0)} שע'). אי אפשר ליצור שיבוץ תקין.`,
    });
  } else if (utilizationPercent > 90) {
    findings.push({
      severity: PreflightSeverity.Warning,
      code: 'HIGH_DENSITY',
      message: `סיכון לצפיפות גבוהה: ${utilizationPercent.toFixed(1)}% ניצולת (${totalRequiredHours.toFixed(0)} שע' נדרשות / ${totalAvailableParticipantHours.toFixed(0)} שע' זמינות). ייתכן שלא תהיה מנוחה מספקת בין משימות.`,
    });
  }

  return { findings, totalRequiredSlots, totalAvailableParticipantHours, totalRequiredHours, utilizationPercent };
}

// ─── Group Integrity ─────────────────────────────────────────────────────────

function checkGroupIntegrity(ctx: PreflightContext): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  if (isDisabled(ctx, 'HC-4') && isDisabled(ctx, 'HC-8')) return findings;

  const groups = [...new Set(ctx.participants.map((p) => p.group))];

  type Item = {
    name: string;
    templateId?: string;
    oneTimeTaskId?: string;
    sameGroupRequired: boolean;
    shiftsPerDay?: number;
    slots: SlotTemplate[];
  };
  const items: Item[] = [];
  for (const tpl of ctx.templates) {
    items.push({
      name: tpl.name,
      templateId: tpl.id,
      sameGroupRequired: tpl.sameGroupRequired,
      shiftsPerDay: tpl.shiftsPerDay,
      slots: collectAllSlots(tpl),
    });
  }
  for (const ot of ctx.oneTimeTasks) {
    items.push({
      name: ot.name,
      oneTimeTaskId: ot.id,
      sameGroupRequired: ot.sameGroupRequired,
      slots: collectAllSlots(ot),
    });
  }

  const groupCanFillItem = (groupMembers: Participant[], slots: SlotTemplate[]): boolean => {
    const slotInputs: SlotCandidates[] = slots.map((slot, i) => ({
      slotId: `${i}`,
      candidates: groupMembers.filter((m) => participantMatchesSlot(m, slot, ctx)).map((m) => m.id),
    }));
    return findMaxMatching(slotInputs).unfilled.length === 0;
  };

  for (const item of items) {
    if (!item.sameGroupRequired) continue;
    if (item.slots.length === 0) continue;

    let anyGroupCanFill = false;
    for (const group of groups) {
      const groupMembers = ctx.participants.filter((p) => p.group === group);
      if (groupCanFillItem(groupMembers, item.slots)) {
        anyGroupCanFill = true;
        break;
      }
    }

    if (!anyGroupCanFill) {
      findings.push({
        severity: PreflightSeverity.Critical,
        code: 'GROUP_INTEGRITY',
        message: `אף קבוצה לא יכולה למלא את כל ${item.slots.length} המשבצות עבור "${item.name}" (נדרשת אותה קבוצה). יש צורך בלפחות קבוצה אחת עם משתתפים מתאימים.`,
        templateId: item.templateId,
        oneTimeTaskId: item.oneTimeTaskId,
      });
    } else if (item.shiftsPerDay && item.shiftsPerDay > 1) {
      const insufficientGroups: string[] = [];
      for (const group of groups) {
        const groupMembers = ctx.participants.filter((p) => p.group === group);
        if (!groupCanFillItem(groupMembers, item.slots)) insufficientGroups.push(group);
      }
      if (insufficientGroups.length > 0) {
        findings.push({
          severity: PreflightSeverity.Warning,
          code: 'GROUP_ROTATION_GAP',
          message: `"${item.name}" כולל ${item.shiftsPerDay} משמרות/יום אך קבוצות [${insufficientGroups.join(', ')}] לא יכולות למלא את כל המשבצות. רוטציית משמרות עלולה להיות מוגבלת.`,
          templateId: item.templateId,
        });
      }
    }
  }

  return findings;
}

// ─── Zero-Slot Tasks ─────────────────────────────────────────────────────────

function checkZeroSlotTasks(ctx: PreflightContext): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  for (const tpl of ctx.templates) {
    if (collectAllSlots(tpl).length === 0) {
      findings.push({
        severity: PreflightSeverity.Warning,
        code: 'ZERO_SLOTS',
        message: `המשימה "${tpl.name}" מוגדרת ללא אף משבצת — היא לא תופיע בשבצ"ק. הוסף משבצות במסך פירוט משימות.`,
        templateId: tpl.id,
      });
    }
  }

  for (const ot of ctx.oneTimeTasks) {
    if (collectAllSlots(ot).length === 0) {
      findings.push({
        severity: PreflightSeverity.Warning,
        code: 'ZERO_SLOTS',
        message: `המשימה החד-פעמית "${ot.name}" מוגדרת ללא אף משבצת — היא לא תופיע בשבצ"ק. הוסף משבצות במסך פירוט משימות.`,
        oneTimeTaskId: ot.id,
      });
    }
  }

  return findings;
}

// ─── Degenerate Template / Slot Configuration ────────────────────────────────

function checkDegenerateConfig(ctx: PreflightContext): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  for (const tpl of ctx.templates) {
    if (!Number.isFinite(tpl.shiftsPerDay) || tpl.shiftsPerDay < 1) {
      findings.push({
        severity: PreflightSeverity.Critical,
        code: 'INVALID_SHIFT_COUNT',
        message: `המשימה "${tpl.name}" מוגדרת עם ${tpl.shiftsPerDay} משמרות ביום — היא לא תיווצר. עדכן ל-1 לפחות.`,
        templateId: tpl.id,
      });
    }
    if (!Number.isFinite(tpl.durationHours) || tpl.durationHours <= 0) {
      findings.push({
        severity: PreflightSeverity.Critical,
        code: 'INVALID_DURATION',
        message: `המשימה "${tpl.name}" מוגדרת עם משך ${tpl.durationHours} שע' — היא לא תיווצר. הגדר משך חיובי.`,
        templateId: tpl.id,
      });
    }
    for (const slot of collectAllSlots(tpl)) {
      if (slot.acceptableLevels.length === 0) {
        findings.push({
          severity: PreflightSeverity.Critical,
          code: 'EMPTY_ACCEPTABLE_LEVELS',
          message: `המשבצת "${slot.label || tpl.name}" במשימה "${tpl.name}" ללא דרגות מותרות — היא תידלג בשבצ"ק.`,
          templateId: tpl.id,
          slotId: slot.id,
        });
      }
    }
  }

  for (const ot of ctx.oneTimeTasks) {
    if (!Number.isFinite(ot.durationHours) || ot.durationHours <= 0) {
      findings.push({
        severity: PreflightSeverity.Critical,
        code: 'INVALID_DURATION',
        message: `המשימה החד-פעמית "${ot.name}" מוגדרת עם משך ${ot.durationHours} שע' — היא לא תיווצר. הגדר משך חיובי.`,
        oneTimeTaskId: ot.id,
      });
    }
    for (const slot of collectAllSlots(ot)) {
      if (slot.acceptableLevels.length === 0) {
        findings.push({
          severity: PreflightSeverity.Critical,
          code: 'EMPTY_ACCEPTABLE_LEVELS',
          message: `המשבצת "${slot.label || ot.name}" במשימה החד-פעמית "${ot.name}" ללא דרגות מותרות — היא תידלג בשבצ"ק.`,
          oneTimeTaskId: ot.id,
          slotId: slot.id,
        });
      }
    }
  }

  return findings;
}

// ─── Orphan Rest Rule References ─────────────────────────────────────────────

function checkRestRuleOrphans(ctx: PreflightContext): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  if (isDisabled(ctx, 'HC-14')) return findings;

  for (const tpl of ctx.templates) {
    if (!tpl.restRuleId) continue;
    const rule = ctx.restRuleLookup(tpl.restRuleId);
    if (!rule || rule.deleted) {
      findings.push({
        severity: PreflightSeverity.Warning,
        code: 'ORPHAN_REST_RULE',
        message: `המשימה "${tpl.name}" מפנה לכלל מרווחים שנמחק — HC-14 לא ייאכף עבורה.`,
        templateId: tpl.id,
      });
    }
  }
  for (const ot of ctx.oneTimeTasks) {
    if (!ot.restRuleId) continue;
    const rule = ctx.restRuleLookup(ot.restRuleId);
    if (!rule || rule.deleted) {
      findings.push({
        severity: PreflightSeverity.Warning,
        code: 'ORPHAN_REST_RULE',
        message: `המשימה החד-פעמית "${ot.name}" מפנה לכלל מרווחים שנמחק — HC-14 לא ייאכף עבורה.`,
        oneTimeTaskId: ot.id,
      });
    }
  }

  return findings;
}

// ─── Stale Sleep-Recovery Trigger Shifts ─────────────────────────────────────

function checkStaleSleepRecovery(ctx: PreflightContext): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  if (isDisabled(ctx, 'HC-15')) return findings;

  for (const tpl of ctx.templates) {
    const rule = tpl.sleepRecovery;
    if (!rule) continue;
    if (!rule.triggerShifts || rule.triggerShifts.length === 0) continue;
    const shiftsPerDay = Math.max(1, tpl.shiftsPerDay || 1);
    const stale = rule.triggerShifts.filter((s) => s < 1 || s > shiftsPerDay);
    if (stale.length === rule.triggerShifts.length) {
      findings.push({
        severity: PreflightSeverity.Warning,
        code: 'STALE_SLEEP_RECOVERY',
        message: `כלל מנוחה במשימה "${tpl.name}" מפעיל משמרות שאינן קיימות (${stale.join(', ')}) — הוא לא יופעל. עדכן את המשמרות הטריגריות.`,
        templateId: tpl.id,
      });
    } else if (stale.length > 0) {
      findings.push({
        severity: PreflightSeverity.Warning,
        code: 'STALE_SLEEP_RECOVERY',
        message: `כלל מנוחה במשימה "${tpl.name}" כולל משמרות לא קיימות (${stale.join(', ')}) שיתעלמו ממנו.`,
        templateId: tpl.id,
      });
    }
  }

  for (const ot of ctx.oneTimeTasks) {
    const rule = ot.sleepRecovery;
    if (!rule) continue;
    if (!rule.triggerShifts || rule.triggerShifts.length === 0) continue;
    const stale = rule.triggerShifts.filter((s) => s !== 1);
    if (stale.length === rule.triggerShifts.length) {
      findings.push({
        severity: PreflightSeverity.Warning,
        code: 'STALE_SLEEP_RECOVERY',
        message: `כלל מנוחה במשימה החד-פעמית "${ot.name}" מפעיל משמרות שאינן קיימות (${stale.join(', ')}) — הוא לא יופעל.`,
        oneTimeTaskId: ot.id,
      });
    }
  }

  return findings;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export interface RunPreflightInputs {
  participants: Participant[];
  templates: TaskTemplate[];
  oneTimeTasks: OneTimeTask[];
  scheduleStart: Date;
  numDays: number;
  dayStartHour: number;
  disabledHC?: Set<string>;
  /** Pass-through of `getAllRestRules()` (includes tombstones) so orphan
   *  detection can distinguish missing-and-never-existed from soft-deleted. */
  restRules?: RestRule[];
  certifications?: { id: string; label: string }[];
}

/**
 * Pure entry point. The web wrapper in `src/web/preflight.ts` calls this with
 * inputs gathered from config-store; tests construct inputs directly.
 */
export function runPreflightWithInputs(inputs: RunPreflightInputs): PreflightResult {
  const restRuleMap = new Map<string, RestRule>();
  for (const r of inputs.restRules ?? []) restRuleMap.set(r.id, r);
  const certMap = new Map<string, string>();
  for (const c of inputs.certifications ?? []) certMap.set(c.id, c.label);

  const winStart = new Date(
    inputs.scheduleStart.getFullYear(),
    inputs.scheduleStart.getMonth(),
    inputs.scheduleStart.getDate(),
  );
  const winEnd = new Date(
    inputs.scheduleStart.getFullYear(),
    inputs.scheduleStart.getMonth(),
    inputs.scheduleStart.getDate() + inputs.numDays,
  );
  const inRangeOts = inputs.oneTimeTasks.filter((ot) => {
    const d = new Date(ot.scheduledDate.getFullYear(), ot.scheduledDate.getMonth(), ot.scheduledDate.getDate());
    return d >= winStart && d < winEnd;
  });

  if (inputs.templates.length === 0 && inRangeOts.length === 0) {
    return {
      canGenerate: false,
      findings: [
        {
          severity: PreflightSeverity.Critical,
          code: 'NO_TASKS',
          message: 'יש להגדיר משימות לפני יצירת שבצ"ק.',
        },
      ],
      utilizationSummary: {
        totalRequiredSlots: 0,
        totalAvailableParticipantHours: 0,
        totalRequiredHours: 0,
        utilizationPercent: 0,
      },
    };
  }

  const ctx: PreflightContext = {
    participants: inputs.participants,
    templates: inputs.templates,
    oneTimeTasks: inRangeOts,
    scheduleStart: inputs.scheduleStart,
    numDays: inputs.numDays,
    dayStartHour: inputs.dayStartHour,
    disabledHC: inputs.disabledHC ?? new Set(),
    restRuleLookup: (id) => restRuleMap.get(id),
    certLabel: (id) => certMap.get(id) ?? id,
    scheduleCtx: {
      baseDate: inputs.scheduleStart,
      dayStartHour: inputs.dayStartHour,
      scheduleDays: inputs.numDays,
    },
  };

  const cap = checkCapacity(ctx);
  const allFindings = [
    ...checkSkillGaps(ctx),
    ...checkPerShiftAvailability(ctx),
    ...cap.findings,
    ...checkGroupIntegrity(ctx),
    ...checkZeroSlotTasks(ctx),
    ...checkDegenerateConfig(ctx),
    ...checkRestRuleOrphans(ctx),
    ...checkStaleSleepRecovery(ctx),
  ];

  return {
    canGenerate: !allFindings.some((f) => f.severity === PreflightSeverity.Critical),
    findings: allFindings,
    utilizationSummary: {
      totalRequiredSlots: cap.totalRequiredSlots,
      totalAvailableParticipantHours: cap.totalAvailableParticipantHours,
      totalRequiredHours: cap.totalRequiredHours,
      utilizationPercent: cap.utilizationPercent,
    },
  };
}
