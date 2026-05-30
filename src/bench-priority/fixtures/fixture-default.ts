/**
 * fixture-default — the control fixture.
 *
 * Replays the production default seed via `store.initStore()` (after a
 * factory reset to ensure clean state). Templates are converted into Task
 * occurrences using the same logic the web app applies in
 * `generateTasksFromTemplates`. The default fixture is the same shape the
 * design experiment that selected the current tiered formula used; it's
 * the baseline against which the bench validates "today's behavior is
 * unchanged on the default fixture."
 *
 * The Hamama-Shemesh priority-19 collision lives in this fixture. It's the
 * primary regression sentinel for Phase 2 (D1+D3) acceptance.
 *
 * Targets: D1+D3 (Phase 2).
 */

import { type Participant, type SchedulerConfig, type SlotRequirement, type Task, type TaskTemplate } from '../../models/types';
import { computeTemplateSectionKey } from '../../shared/layout-key';
import { generateShiftBlocks, hourInOpDay } from '../../shared/utils/time-utils';
import type { FixtureInstance, FixtureSpec } from '../types';
import { DEFAULT_BASE_DATE, defaultBenchConfig, wideAvailability } from './shared';

/**
 * Build `Task[]` from a list of `TaskTemplate`. Mirrors the production
 * `generateTasksFromTemplates` in `src/web/app.ts` — same iteration order
 * (template × day × shift × subTeam.slot, then template.slots), same
 * shift-index assignment, same id format. Kept independent of the live app
 * so the bench doesn't pull in DOM/web dependencies.
 */
function buildTasksFromTemplates(
  numDays: number,
  baseDate: Date,
  dayStartHour: number,
  templates: TaskTemplate[],
): Task[] {
  let slotCounter = 0;
  let taskCounter = 0;
  const allTasks: Task[] = [];

  for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
    const dayLabel = `D${dayIdx + 1}`;
    for (const tpl of templates) {
      if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) continue;
      const startDate = new Date(hourInOpDay(baseDate, dayStartHour, dayIdx + 1, tpl.startHour));
      const shifts: { start: Date; end: Date }[] =
        tpl.shiftsPerDay === 1
          ? [{ start: startDate, end: new Date(startDate.getTime() + tpl.durationHours * 3600000) }]
          : generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);

      for (let si = 0; si < shifts.length; si++) {
        const block = shifts[si];
        const slots: SlotRequirement[] = [];

        for (const st of tpl.subTeams) {
          for (const s of st.slots) {
            if (s.acceptableLevels.length === 0) continue;
            slots.push({
              slotId: `${tpl.name.toLowerCase()}-slot-${++slotCounter}`,
              acceptableLevels: [...s.acceptableLevels],
              requiredCertifications: [...s.requiredCertifications],
              forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
              label: s.label,
              subTeamLabel: st.name,
              subTeamId: st.id,
            });
          }
        }
        for (const s of tpl.slots) {
          if (s.acceptableLevels.length === 0) continue;
          slots.push({
            slotId: `${tpl.name.toLowerCase()}-slot-${++slotCounter}`,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
            label: s.label,
          });
        }
        if (slots.length === 0) continue;

        const shiftLabel = tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : '';
        allTasks.push({
          id: `${tpl.name.toLowerCase()}-d${dayIdx + 1}-${++taskCounter}`,
          name: `${dayLabel} ${tpl.name}${shiftLabel}`,
          sourceName: tpl.name,
          timeBlock: block,
          requiredCount: slots.length,
          slots,
          baseLoadWeight: tpl.baseLoadWeight,
          loadWindows: (tpl.loadWindows ?? []).map((w) => ({ ...w })),
          sameGroupRequired: tpl.sameGroupRequired,
          blocksConsecutive: tpl.blocksConsecutive,
          schedulingPriority: tpl.schedulingPriority,
          togethernessRelevant: tpl.togethernessRelevant,
          restRuleId: tpl.restRuleId,
          sleepRecovery: tpl.sleepRecovery
            ? { ...tpl.sleepRecovery, triggerShifts: [...tpl.sleepRecovery.triggerShifts] }
            : undefined,
          shiftIndex: si + 1,
          sectionKey: computeTemplateSectionKey(tpl),
          color: tpl.color || '#7f8c8d',
        });
      }
    }
  }
  return allTasks;
}

/** Widen each participant's availability so HC-3 doesn't reject any task
 *  for the bench's chosen baseDate / periodDays. */
function widenAvailability(participants: Participant[], baseDate: Date, periodDays: number): Participant[] {
  const wide = wideAvailability(baseDate, periodDays);
  return participants.map((p) => ({ ...p, availability: wide }));
}

/** Build a rest-rule-id → durationMs map from the store's rest rules. */
function buildRestRuleMap(store: typeof import('../../web/config-store')): Map<string, number> {
  const map = new Map<string, number>();
  for (const rr of store.getAllRestRules()) {
    map.set(rr.id, rr.durationHours * 3600000);
  }
  return map;
}

export const DEFAULT_FIXTURE: FixtureSpec = {
  id: 'fixture-default',
  description: 'Production default seed (4 groups × 12 participants × 8 templates) — control fixture; Hamama-Shemesh collision lives here.',
  targetingPhase: 'D1+D3',
  generate: (_seed: number): FixtureInstance => {
    // Lazy import to avoid loading config-store (and its localStorage
    // dependency) when this fixture isn't used.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require('../../web/config-store') as typeof import('../../web/config-store');
    // Reset and re-seed for isolation between fixture calls. The default
    // fixture's content is independent of `seed` — same seed-different-seed
    // produces the same fixture by design.
    store.factoryReset();
    store.initStore();

    const periodDays = 7;
    const baseDate = DEFAULT_BASE_DATE;
    const dayStartHour = store.getDayStartHour();
    const templates = store.getAllTaskTemplates();
    const tasks = buildTasksFromTemplates(periodDays, baseDate, dayStartHour, templates);
    const participants = widenAvailability(store.getAllParticipants(), baseDate, periodDays);
    const config: SchedulerConfig = defaultBenchConfig();
    const restRuleMap = buildRestRuleMap(store);

    return {
      participants,
      tasks,
      config,
      restRuleMap,
      dayStartHour,
      baseDate,
      periodDays,
    };
  },
};
