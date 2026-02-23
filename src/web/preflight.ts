/**
 * Preflight Validator — Real-time feasibility checks before schedule generation.
 *
 * Checks:
 * 1. Skill Gap: slots requiring attributes no participant possesses
 * 2. Capacity Alert: total man-hours vs required hours (>90% = high-density risk)
 * 3. Group Integrity: for sameGroupRequired tasks, each group must fill all sub-team roles
 */

import {
  Participant,
  Level,
  Certification,
  TaskTemplate,
  SlotTemplate,
  PreflightSeverity,
  PreflightFinding,
  PreflightResult,
} from '../models/types';
import {
  getAllParticipants,
  getAllTaskTemplates,
  getGroups,
  getScheduleDate,
  getScheduleDays,
} from './config-store';
import { computeAllCapacities } from '../utils/capacity';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function participantMatchesSlot(p: Participant, slot: SlotTemplate): boolean {
  // Level check
  if (!slot.acceptableLevels.includes(p.level)) return false;
  // Cert check
  for (const cert of slot.requiredCertifications) {
    if (!p.certifications.includes(cert)) return false;
  }
  return true;
}

function collectAllSlots(tpl: TaskTemplate): SlotTemplate[] {
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

function checkSkillGaps(participants: Participant[], templates: TaskTemplate[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];

  for (const tpl of templates) {
    const allSlots = collectAllSlots(tpl);

    for (const slot of allSlots) {
      const eligible = participants.filter(p => participantMatchesSlot(p, slot));
      if (eligible.length === 0) {
        // Build a human-readable requirement string
        const levelStr = slot.acceptableLevels.map(l => `דרגה ${l}`).join('/');
        const certStr = slot.requiredCertifications.length > 0
          ? ` + ${slot.requiredCertifications.join(', ')}`
          : '';
        findings.push({
          severity: PreflightSeverity.Critical,
          code: 'SKILL_GAP',
          message: `אין משתתפים העומדים בדרישת ${levelStr}${certStr} עבור משימה "${tpl.name}" משבצת "${slot.label}".`,
          templateId: tpl.id,
          slotId: slot.id,
        });
      } else if (eligible.length === 1) {
        findings.push({
          severity: PreflightSeverity.Warning,
          code: 'SKILL_SCARCITY',
          message: `רק משתתף אחד יכול למלא משבצת "${slot.label}" במשימה "${tpl.name}" (${eligible[0].name}). אין חלופה זמינה.`,
          templateId: tpl.id,
          slotId: slot.id,
        });
      }
    }
  }

  return findings;
}

// ─── Capacity Check ──────────────────────────────────────────────────────────

function checkCapacity(participants: Participant[], templates: TaskTemplate[]): {
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

  // Calculate total available hours using capacity calculator.
  // This accounts for both AvailabilityWindow ranges and DateUnavailability
  // holes, giving a more accurate picture than raw availability windows.
  const scheduleStart = getScheduleDate();
  const scheduleEnd = new Date(scheduleStart);
  scheduleEnd.setDate(scheduleEnd.getDate() + numDays - 1);
  const capacities = computeAllCapacities(participants, scheduleStart, scheduleEnd);
  let totalAvailableParticipantHours = 0;
  for (const cap of capacities.values()) {
    totalAvailableParticipantHours += cap.totalAvailableHours;
  }

  const utilizationPercent = totalAvailableParticipantHours > 0
    ? (totalRequiredHours / totalAvailableParticipantHours) * 100
    : 100;

  if (utilizationPercent > 100) {
    findings.push({
      severity: PreflightSeverity.Critical,
      code: 'CAPACITY_EXCEEDED',
      message: `שעות נדרשות (${totalRequiredHours.toFixed(0)} שע') חורגות משעות זמינות (${totalAvailableParticipantHours.toFixed(0)} שע'). השבצ"ק בלתי אפשרי.`,
    });
  } else if (utilizationPercent > 90) {
    findings.push({
      severity: PreflightSeverity.Warning,
      code: 'HIGH_DENSITY',
      message: `סיכון צפיפות גבוהה: ${utilizationPercent.toFixed(1)}% ניצולת (${totalRequiredHours.toFixed(0)} שע' נדרשות / ${totalAvailableParticipantHours.toFixed(0)} שע' זמינות). ייתכן שלא יישאר מנוחה מספקת בין משימות.`,
    });
  }

  return { findings, totalRequiredSlots, totalAvailableParticipantHours, totalRequiredHours, utilizationPercent };
}

// ─── Group Integrity Check ───────────────────────────────────────────────────

function checkGroupIntegrity(participants: Participant[], templates: TaskTemplate[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const groups = [...new Set(participants.map(p => p.group))];

  for (const tpl of templates) {
    if (!tpl.sameGroupRequired) continue;
    const allSlots = collectAllSlots(tpl);
    if (allSlots.length === 0) continue;

    // For each group, check if they can fill ALL slots simultaneously
    let anyGroupCanFill = false;

    for (const group of groups) {
      const groupMembers = participants.filter(p => p.group === group);
      let canFillAll = true;

      // Greedy check: try to assign each slot to a different member
      const used = new Set<string>();
      for (const slot of allSlots) {
        const eligible = groupMembers.filter(
          m => !used.has(m.id) && participantMatchesSlot(m, slot)
        );
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
        message: `אף קבוצה לא יכולה למלא את כל ${allSlots.length} המשבצות עבור "${tpl.name}" (נדרשת אותה קבוצה). נדרשת לפחות קבוצה אחת עם משתתפים מתאימים.`,
        templateId: tpl.id,
      });
    } else {
      // Check if ALL groups can fill (desirable for shift rotation)
      const insufficientGroups: string[] = [];
      for (const group of groups) {
        const groupMembers = participants.filter(p => p.group === group);
        const used = new Set<string>();
        let canFill = true;
        for (const slot of allSlots) {
          const eligible = groupMembers.filter(
            m => !used.has(m.id) && participantMatchesSlot(m, slot)
          );
          if (eligible.length === 0) { canFill = false; break; }
          used.add(eligible[0].id);
        }
        if (!canFill) insufficientGroups.push(group);
      }

      if (insufficientGroups.length > 0 && tpl.shiftsPerDay > 1) {
        findings.push({
          severity: PreflightSeverity.Warning,
          code: 'GROUP_ROTATION_GAP',
          message: `"${tpl.name}" כולל ${tpl.shiftsPerDay} משמרות/יום אך קבוצות [${insufficientGroups.join(', ')}] לא יכולות למלא את כל המשבצות. רוטציית משמרות עלולה להיות מוגבלת.`,
          templateId: tpl.id,
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

  const skillGapFindings = checkSkillGaps(participants, templates);
  const capacityResult = checkCapacity(participants, templates);
  const groupFindings = checkGroupIntegrity(participants, templates);

  const allFindings = [
    ...skillGapFindings,
    ...capacityResult.findings,
    ...groupFindings,
  ];

  const hasCritical = allFindings.some(f => f.severity === PreflightSeverity.Critical);

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
