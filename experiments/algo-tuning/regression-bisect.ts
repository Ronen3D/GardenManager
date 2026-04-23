/**
 * Regression bisect: pool 36 group-removal at default 60 attempts.
 *
 * Quickly checks whether the current working tree produces more unfilled slots
 * than the baseline. Uses optimizeMultiAttempt directly — passes scheduleContext
 * so the production HC-3 path is faithfully exercised.
 *
 * Run with:
 *   npx ts-node --project experiments/algo-tuning/tsconfig.json \
 *     experiments/algo-tuning/regression-bisect.ts [seeds]
 */

class ShimStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.get(k) ?? null; }
  setItem(k: string, v: string): void { this.store.set(k, String(v)); }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); }
  get length(): number { return this.store.size; }
  key(i: number): string | null { return Array.from(this.store.keys())[i] ?? null; }
}
(globalThis as any).localStorage = new ShimStorage();
(globalThis as any).sessionStorage = new ShimStorage();

import { optimizeMultiAttempt } from '../../src/engine/optimizer';
import {
  type Participant,
  type SchedulerConfig,
  type SlotRequirement,
  type Task,
  DEFAULT_CONFIG,
} from '../../src/models/types';
import { generateShiftBlocks } from '../../src/shared/utils/time-utils';

// Inline-typed ScheduleContext (HEAD-compatible: this type may not exist on HEAD)
interface LocalScheduleContext {
  baseDate: Date;
  scheduleDays: number;
  dayStartHour: number;
}

const configStore = require('../../src/web/config-store');
const {
  initStore,
  getAllParticipants,
  getAllTaskTemplates,
  getAllRestRules,
  getDayStartHour,
  setScheduleDays,
  getScheduleDate,
} = configStore as {
  initStore(): void;
  getAllParticipants(): Participant[];
  getAllTaskTemplates(): any[];
  getAllRestRules(): { id: string; durationHours: number }[];
  getDayStartHour(): number;
  setScheduleDays(n: number): void;
  getScheduleDate(): Date;
};

let _slotCounter = 0;
let _taskCounter = 0;

function buildTasks(numDays: number, baseDate: Date): Task[] {
  _slotCounter = 0;
  _taskCounter = 0;
  const templates = getAllTaskTemplates();
  const allTasks: Task[] = [];

  for (let dayIdx = 0; dayIdx < numDays; dayIdx++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayIdx);
    const dayLabel = `D${dayIdx + 1}`;

    for (const tpl of templates) {
      if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) continue;
      const startDate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);

      let shifts: { start: Date; end: Date }[];
      if (tpl.eveningStartHour !== undefined && tpl.shiftsPerDay === 2) {
        const morningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), tpl.startHour, 0);
        const morningEnd = new Date(morningStart.getTime() + tpl.durationHours * 3600000);
        const eveHour = tpl.eveningStartHour;
        const eveningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), eveHour, 0);
        const eveningEnd = new Date(eveningStart.getTime() + tpl.durationHours * 3600000);
        shifts = [
          { start: morningStart, end: morningEnd },
          { start: eveningStart, end: eveningEnd },
        ];
      } else if (tpl.shiftsPerDay === 1) {
        shifts = [{ start: startDate, end: new Date(startDate.getTime() + tpl.durationHours * 3600000) }];
      } else {
        shifts = generateShiftBlocks(startDate, tpl.durationHours, tpl.shiftsPerDay);
      }

      for (let si = 0; si < shifts.length; si++) {
        const block = shifts[si];
        const slots: SlotRequirement[] = [];

        for (const st of tpl.subTeams ?? []) {
          for (const s of st.slots) {
            if (s.acceptableLevels.length === 0) continue;
            slots.push({
              slotId: `${tpl.name.toLowerCase()}-slot-${++_slotCounter}`,
              acceptableLevels: [...s.acceptableLevels],
              requiredCertifications: [...s.requiredCertifications],
              forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
              label: s.label,
              subTeamLabel: st.name,
              subTeamId: st.id,
            });
          }
        }
        for (const s of tpl.slots ?? []) {
          if (s.acceptableLevels.length === 0) continue;
          slots.push({
            slotId: `${tpl.name.toLowerCase()}-slot-${++_slotCounter}`,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
            label: s.label,
          });
        }

        if (slots.length === 0) continue;

        const shiftLabel = tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : '';
        allTasks.push({
          id: `${tpl.name.toLowerCase()}-d${dayIdx + 1}-${++_taskCounter}`,
          name: `${dayLabel} ${tpl.name}${shiftLabel}`,
          sourceName: tpl.name,
          timeBlock: block,
          requiredCount: slots.length,
          slots,
          baseLoadWeight: tpl.baseLoadWeight,
          loadWindows: (tpl.loadWindows ?? []).map((w: any) => ({ ...w })),
          sameGroupRequired: tpl.sameGroupRequired,
          blocksConsecutive: tpl.blocksConsecutive,
          schedulingPriority: tpl.schedulingPriority,
          togethernessRelevant: tpl.togethernessRelevant,
          restRuleId: tpl.restRuleId,
          sleepRecovery: tpl.sleepRecovery ? { ...tpl.sleepRecovery } : undefined,
          displayCategory: tpl.displayCategory,
          color: tpl.color || '#7f8c8d',
        });
      }
    }
  }
  return allTasks;
}

function buildPoolByRemovingGroups(allParticipants: Participant[], groupsToRemove: number): Participant[] {
  const byGroup = new Map<string, Participant[]>();
  for (const p of allParticipants) {
    const g = p.group ?? '_';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(p);
  }
  const groupNames = [...byGroup.keys()];
  const keepGroups = new Set(groupNames.slice(0, Math.max(0, groupNames.length - groupsToRemove)));
  const result: Participant[] = [];
  for (const [groupName, list] of byGroup) {
    if (keepGroups.has(groupName)) result.push(...list);
  }
  return result;
}

async function main() {
  const seeds = Number(process.argv[2] ?? '6');
  const attempts = 60;

  // Bisect knobs (set via env)
  if (process.env.DISABLE_HC15_SWAP === '1') (globalThis as any).__BISECT_DISABLE_HC15_SWAP = true;
  if (process.env.SKIP_DATEUNAVAIL === '1') (globalThis as any).__BISECT_SKIP_DATEUNAVAIL = true;
  if (process.env.EI) (globalThis as any).__BISECT_EI = Number(process.env.EI);
  console.log('  bisect flags:', {
    DISABLE_HC15_SWAP: !!(globalThis as any).__BISECT_DISABLE_HC15_SWAP,
    SKIP_DATEUNAVAIL: !!(globalThis as any).__BISECT_SKIP_DATEUNAVAIL,
    EI: (globalThis as any).__BISECT_EI ?? 'default(20)',
  });

  console.log('Initializing store…');
  initStore();
  setScheduleDays(7);

  const allParticipants = getAllParticipants();
  console.log(`  default pool: ${allParticipants.length} participants`);

  const subset = buildPoolByRemovingGroups(allParticipants, 1);
  const groups = [...new Set(subset.map((p) => p.group))];
  console.log(`  test pool: ${subset.length} ppl, groups kept: ${groups.join(', ')}`);

  const tasks = buildTasks(7, getScheduleDate());
  const totalSlots = tasks.reduce((sum, t) => sum + t.slots.length, 0);
  console.log(`  workload: ${tasks.length} tasks, ${totalSlots} slots`);

  const restRules = getAllRestRules();
  const restRuleMap = new Map(restRules.map((r) => [r.id, r.durationHours]));
  const dayStartHour = getDayStartHour();
  const config: SchedulerConfig = { ...DEFAULT_CONFIG, maxIterations: 100000, maxSolverTimeMs: 30000 };

  // Build scheduleContext exactly as the engine would (operational-day base from earliest task)
  let minStart = tasks[0].timeBlock.start;
  for (const t of tasks) if (t.timeBlock.start < minStart) minStart = t.timeBlock.start;
  const baseDate = new Date(
    minStart.getFullYear(),
    minStart.getMonth(),
    minStart.getDate() - (minStart.getHours() < dayStartHour ? 1 : 0),
  );
  const scheduleContext: LocalScheduleContext = { baseDate, scheduleDays: 7, dayStartHour };

  console.log(`\n=== Regression bisect: pool ${subset.length}, ${attempts} attempts × ${seeds} seeds ===`);
  console.log(`  scheduleContext: baseDate=${baseDate.toISOString().slice(0, 10)} dayStartHour=${dayStartHour}`);

  const unfilledList: number[] = [];
  const tList: number[] = [];
  for (let s = 0; s < seeds; s++) {
    const t0 = Date.now();
    const result = (optimizeMultiAttempt as any)(
      tasks,
      subset,
      config,
      [],
      attempts,
      undefined,
      undefined,
      undefined,
      restRuleMap,
      undefined,
      scheduleContext,
      dayStartHour,
    );
    const t1 = Date.now();
    const unf = result.unfilledSlots.length;
    unfilledList.push(unf);
    tList.push((t1 - t0) / 1000);
    console.log(`  seed ${s + 1}: unfilled=${unf}  score=${result.score.compositeScore.toFixed(0)}  t=${((t1 - t0) / 1000).toFixed(1)}s`);
  }

  const mean = unfilledList.reduce((a, b) => a + b, 0) / unfilledList.length;
  const min = Math.min(...unfilledList);
  const max = Math.max(...unfilledList);
  const med = [...unfilledList].sort((a, b) => a - b)[Math.floor(unfilledList.length / 2)];
  const tMean = tList.reduce((a, b) => a + b, 0) / tList.length;
  console.log(`\n  RESULT: unfilled mean=${mean.toFixed(2)} med=${med} [min=${min}, max=${max}]  meanTime=${tMean.toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
