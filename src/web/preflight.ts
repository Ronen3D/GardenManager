/**
 * Preflight Validator — Real-time feasibility checks before schedule generation.
 *
 * Checks:
 * 1. Skill Gap: slots requiring attributes no participant possesses
 * 2. Capacity Alert: total man-hours vs required hours (>90% = high-density risk)
 * 3. Group Integrity: for sameGroupRequired tasks, each group must fill all sub-team roles
 */

import {
  Level,
  type OneTimeTask,
  type Participant,
  type PreflightFinding,
  type PreflightResult,
  PreflightSeverity,
  type SlotTemplate,
  type TaskTemplate,
} from '../models/types';
import { computeAllCapacities } from '../utils/capacity';
import {
  getAllOneTimeTasks,
  getAllParticipants,
  getAllTaskTemplates,
  getDayStartHour,
  getGroups,
  getScheduleDate,
  getScheduleDays,
} from './config-store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function participantMatchesSlot(p: Participant, slot: SlotTemplate): boolean {
  // Level check
  if (!slot.acceptableLevels.some((e) => e.level === p.level)) return false;
  // Cert check
  for (const cert of slot.requiredCertifications) {
    if (!p.certifications.includes(cert)) return false;
  }
  return true;
}

function collectAllSlots(tpl: TaskTemplate | OneTimeTask): SlotTemplate[] {
  const all: SlotTemplate[] = [...tpl.slots];
  for (const st of tpl.subTeams) {
    all.push(...st.slots);
  }
  return all;
}

function totalSlotsPerShift(tpl: TaskTemplate): number {
  return collectAllSlots(tpl).length;
}

// ─── Skill Gap Check ─────────────────────────────────────────────────────────

function checkSkillGaps(
  participants: Participant[],
  templates: TaskTemplate[],
  oneTimeTasks: OneTimeTask[],
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  for (const tpl of templates) {
    const allSlots = collectAllSlots(tpl);

    for (const slot of allSlots) {
      const eligible = participants.filter((p) => participantMatchesSlot(p, slot));
      if (eligible.length === 0) {
        // Build a human-readable requirement string
        const levelStr = slot.acceptableLevels.map((l) => `דרגה ${l.level}`).join('/');
        const certStr = slot.requiredCertifications.length > 0 ? ` + ${slot.requiredCertifications.join(', ')}` : '';
        findings.push({
          severity: PreflightSeverity.Critical,
          code: 'SKILL_GAP',
          message: `אין משתתפים שמתאימים לדרישה ${levelStr}${certStr} עבור המשימה "${tpl.name}" במשבצת "${slot.label || tpl.name}".`,
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

  // Check one-time tasks (only those within scheduling window)
  for (const ot of oneTimeTasks) {
    const allSlots = collectAllSlots(ot);
    for (const slot of allSlots) {
      const eligible = participants.filter((p) => participantMatchesSlot(p, slot));
      if (eligible.length === 0) {
        const levelStr = slot.acceptableLevels.map((l) => `דרגה ${l.level}`).join('/');
        const certStr = slot.requiredCertifications.length > 0 ? ` + ${slot.requiredCertifications.join(', ')}` : '';
        findings.push({
          severity: PreflightSeverity.Critical,
          code: 'SKILL_GAP',
          message: `אין משתתפים שמתאימים לדרישה ${levelStr}${certStr} עבור המשימה החד-פעמית "${ot.name}" במשבצת "${slot.label || ot.name}".`,
        });
      } else if (eligible.length === 1) {
        findings.push({
          severity: PreflightSeverity.Warning,
          code: 'SKILL_SCARCITY',
          message: `רק משתתף אחד יכול לאייש את המשבצת "${slot.label || ot.name}" במשימה החד-פעמית "${ot.name}" (${eligible[0].name}).`,
        });
      }
    }
  }

  return findings;
}

// ─── Capacity Check ──────────────────────────────────────────────────────────

function checkCapacity(
  participants: Participant[],
  templates: TaskTemplate[],
  oneTimeTasks: OneTimeTask[],
): {
  findings: PreflightFinding[];
  totalRequiredSlots: number;
  totalAvailableParticipantHours: number;
  totalRequiredHours: number;
  utilizationPercent: number;
} {
  const findings: PreflightFinding[] = [];

  // Calculate total required hours = sum(template.shiftsPerDay * template.durationHours * slotCount) * numDays
  const numDays = getScheduleDays();
  let totalRequiredHours = 0;
  let totalRequiredSlots = 0;
  for (const tpl of templates) {
    const slotsPerShift = totalSlotsPerShift(tpl);
    const hoursPerSlot = tpl.durationHours * tpl.shiftsPerDay;
    totalRequiredHours += slotsPerShift * hoursPerSlot * numDays;
    totalRequiredSlots += slotsPerShift * tpl.shiftsPerDay * numDays;
  }

  // Add one-time tasks (1 instance each)
  for (const ot of oneTimeTasks) {
    const slotsCount = collectAllSlots(ot).length;
    totalRequiredHours += slotsCount * ot.durationHours;
    totalRequiredSlots += slotsCount;
  }

  // Calculate total available hours using capacity calculator.
  // This accounts for both AvailabilityWindow ranges and DateUnavailability
  // holes, giving a more accurate picture than raw availability windows.
  const scheduleStart = getScheduleDate();
  const scheduleEnd = new Date(scheduleStart);
  // scheduleEnd is exclusive (see computeParticipantCapacity): advance by numDays
  // so every operational day in the window is walked. Using numDays-1 previously
  // collapsed the window to zero for numDays=1 and dropped the final day otherwise.
  scheduleEnd.setDate(scheduleEnd.getDate() + numDays);
  const capacities = computeAllCapacities(participants, scheduleStart, scheduleEnd, getDayStartHour());
  let totalAvailableParticipantHours = 0;
  for (const cap of capacities.values()) {
    totalAvailableParticipantHours += cap.totalAvailableHours;
  }

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

// ─── Group Integrity Check ───────────────────────────────────────────────────

function checkGroupIntegrity(
  participants: Participant[],
  templates: TaskTemplate[],
  oneTimeTasks: OneTimeTask[],
): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const groups = [...new Set(participants.map((p) => p.group))];

  // Check both templates and one-time tasks that require same group
  const items: Array<{
    name: string;
    id?: string;
    sameGroupRequired: boolean;
    shiftsPerDay?: number;
    slots: SlotTemplate[];
  }> = [];
  for (const tpl of templates) {
    items.push({
      name: tpl.name,
      id: tpl.id,
      sameGroupRequired: tpl.sameGroupRequired,
      shiftsPerDay: tpl.shiftsPerDay,
      slots: collectAllSlots(tpl),
    });
  }
  for (const ot of oneTimeTasks) {
    items.push({ name: ot.name, sameGroupRequired: ot.sameGroupRequired, slots: collectAllSlots(ot) });
  }

  for (const item of items) {
    if (!item.sameGroupRequired) continue;
    if (item.slots.length === 0) continue;

    // For each group, check if they can fill ALL slots simultaneously
    let anyGroupCanFill = false;

    for (const group of groups) {
      const groupMembers = participants.filter((p) => p.group === group);
      let canFillAll = true;

      // Greedy check: try to assign each slot to a different member
      const used = new Set<string>();
      for (const slot of item.slots) {
        const eligible = groupMembers.filter((m) => !used.has(m.id) && participantMatchesSlot(m, slot));
        if (eligible.length === 0) {
          canFillAll = false;
          break;
        }
        used.add(eligible[0].id);
      }

      if (canFillAll) {
        anyGroupCanFill = true;
        break; // At least one group can fill: sufficient
      }
    }

    if (!anyGroupCanFill) {
      findings.push({
        severity: PreflightSeverity.Critical,
        code: 'GROUP_INTEGRITY',
        message: `אף קבוצה לא יכולה למלא את כל ${item.slots.length} המשבצות עבור "${item.name}" (נדרשת אותה קבוצה). יש צורך בלפחות קבוצה אחת עם משתתפים מתאימים.`,
        templateId: item.id,
      });
    } else if (item.shiftsPerDay && item.shiftsPerDay > 1) {
      // Check if ALL groups can fill (desirable for shift rotation)
      const insufficientGroups: string[] = [];
      for (const group of groups) {
        const groupMembers = participants.filter((p) => p.group === group);
        const used = new Set<string>();
        let canFill = true;
        for (const slot of item.slots) {
          const eligible = groupMembers.filter((m) => !used.has(m.id) && participantMatchesSlot(m, slot));
          if (eligible.length === 0) {
            canFill = false;
            break;
          }
          used.add(eligible[0].id);
        }
        if (!canFill) insufficientGroups.push(group);
      }

      if (insufficientGroups.length > 0) {
        findings.push({
          severity: PreflightSeverity.Warning,
          code: 'GROUP_ROTATION_GAP',
          message: `"${item.name}" כולל ${item.shiftsPerDay} משמרות/יום אך קבוצות [${insufficientGroups.join(', ')}] לא יכולות למלא את כל המשבצות. רוטציית משמרות עלולה להיות מוגבלת.`,
          templateId: item.id,
        });
      }
    }
  }

  return findings;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function runPreflight(): PreflightResult {
  const participants = getAllParticipants();
  const templates = getAllTaskTemplates();

  // Filter one-time tasks to those within the scheduling window
  const scheduleStart = getScheduleDate();
  const numDays = getScheduleDays();
  const windowStart = new Date(scheduleStart.getFullYear(), scheduleStart.getMonth(), scheduleStart.getDate());
  const windowEnd = new Date(scheduleStart.getFullYear(), scheduleStart.getMonth(), scheduleStart.getDate() + numDays);
  const allOts = getAllOneTimeTasks();
  const inRangeOts = allOts.filter((ot) => {
    const otDay = new Date(ot.scheduledDate.getFullYear(), ot.scheduledDate.getMonth(), ot.scheduledDate.getDate());
    return otDay >= windowStart && otDay < windowEnd;
  });

  // ── Zero-templates guard ──
  if (templates.length === 0 && inRangeOts.length === 0) {
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

  const skillGapFindings = checkSkillGaps(participants, templates, inRangeOts);
  const capacityResult = checkCapacity(participants, templates, inRangeOts);
  const groupFindings = checkGroupIntegrity(participants, templates, inRangeOts);
  const allFindings = [...skillGapFindings, ...capacityResult.findings, ...groupFindings];

  const hasCritical = allFindings.some((f) => f.severity === PreflightSeverity.Critical);

  return {
    canGenerate: !hasCritical,
    findings: allFindings,
    utilizationSummary: {
      totalRequiredSlots: capacityResult.totalRequiredSlots,
      totalAvailableParticipantHours: capacityResult.totalAvailableParticipantHours,
      totalRequiredHours: capacityResult.totalRequiredHours,
      utilizationPercent: capacityResult.utilizationPercent,
    },
  };
}
