/**
 * Scenario generators for the shift-splitting parameter benchmark.
 *
 * A *scenario* is a (days, poolSize, taskRecipe, splittableSet, availability)
 * tuple that completely determines the world the optimizer faces. Splittable
 * flags are stamped HERE — switching splitting OFF is modeled as
 * `splittableSet = 'none'` (i.e. `Task.splittable = false` on every task),
 * exactly as the web layer freezes the effective flag.
 *
 * All scenarios share:
 *  - dayStartHour = 5
 *  - restRuleMap with 'demo-rest-rule' = 5h
 *  - a sleep-recovery rule attached to every 'שמש' guard occurrence so
 *    HC-12/HC-14/HC-15 + loadWindows are exercised together
 *
 * Variation knobs live in the `ScenarioSpec` interface below. Each spec is
 * deterministic (no Math.random in scenario construction) so reruns produce
 * byte-identical task/participant lists.
 */

import { Level, type Participant, type SleepRecoveryRule, type Task } from '../models/types';
import { createTimeBlockFromHours, generateShiftBlocks } from '../shared/utils/time-utils';
import { generateWeeklyTasks } from '../tasks/cli-task-factory';

// ─── Spec ────────────────────────────────────────────────────────────────────

export type TaskRecipe =
  | 'default' // full generateWeeklyTasks output
  | 'lite' // strip ערוגות and one karov shift — lighter pressure
  | 'heavy' // duplicate the 4h שמש shifts — more demand on splittable resources
  | 'extra-shemesh-slots' // bump שמש requiredCount 2→3 (more L0 demand)
  | 'quality-opportunity' // default + restRule only on every other שמש (uneven load)
  | 'tight-feasibility' // default tasks but only 3 שמש shifts/day, each 8h
  | 'split-focused'; // strip same-group tasks; keep only splittable-friendly ones

export type SplittableSet =
  | 'none' // splitting OFF (Task.splittable = false everywhere)
  | 'all-non-sameGroup' // every non-sameGroup task is splittable
  | 'shemesh-only' // only the שמש guard tasks are splittable
  | 'half-non-sameGroup' // every other non-sameGroup task is splittable
  | 'all-incl-sameGroup'; // also includes אדנית — exercises splitSameGroup

export type AvailabilityPressure =
  | 'none' // no DateUnavailability
  | 'low' // ~1/12 participants get one 6h gap (very mild)
  | 'medium' // ~1/9 get one 6h gap (existing bench default)
  | 'high' // ~1/6 get one 6h gap
  | 'very-high'; // ~1/4 get a multi-day 12h gap

export interface ScenarioSpec {
  /** Stable human-readable key — used in result aggregation. */
  id: string;
  days: number; // 1..7
  poolSize: number; // total participants
  taskRecipe: TaskRecipe;
  splittableSet: SplittableSet;
  availability: AvailabilityPressure;
  /** Optional override: when defined, includes only tasks whose sourceName matches. */
  taskSourceFilter?: (sourceName: string) => boolean;
}

export interface BuiltScenario {
  spec: ScenarioSpec;
  tasks: Task[];
  participants: Participant[];
  baseDate: Date;
  dayStartHour: number;
  restRuleMap: Map<string, number>;
}

// ─── Participant pool ────────────────────────────────────────────────────────

const GROUPS = ['קבוצה 1', 'קבוצה 2', 'קבוצה 3', 'קבוצה 4'];

/**
 * Round-robin level/cert template. Compared to `src/bench-shift-split.ts`, ½
 * of the L0 cohort carries `Salsala` so the cli-factory's כרוב "נהג" slot
 * (L0+Nitzan+Salsala) is fillable — otherwise that slot is structurally
 * impossible and inflates unfilled counts without exercising splitting.
 * Senior coverage is otherwise identical to the existing bench.
 */
const SPEC: Array<{ level: Level; certs: string[] }> = [
  { level: Level.L4, certs: ['Nitzan', 'Hamama'] },
  { level: Level.L3, certs: ['Nitzan', 'Hamama'] },
  { level: Level.L2, certs: ['Nitzan', 'Hamama'] },
  { level: Level.L2, certs: ['Nitzan'] },
  { level: Level.L0, certs: ['Nitzan', 'Hamama', 'Salsala'] },
  { level: Level.L0, certs: ['Nitzan', 'Salsala'] },
  { level: Level.L0, certs: ['Nitzan'] },
  { level: Level.L0, certs: ['Nitzan', 'Horesh'] },
];

function gapPolicy(
  availability: AvailabilityPressure,
  index: number,
  spanDays: number,
): Array<{ id: string; dayIndex: number; startHour: number; endHour: number; allDay: boolean; endDayIndex?: number }> {
  const id = `p${index + 1}`;
  switch (availability) {
    case 'none':
      return [];
    case 'low': {
      if (index % 12 !== 4) return [];
      const day = 2 + (index % Math.max(1, spanDays - 2));
      return [{ id: `du-${id}`, dayIndex: day, startHour: 12, endHour: 18, allDay: false }];
    }
    case 'medium': {
      if (index % 9 !== 4) return [];
      const day = 2 + (index % Math.max(1, spanDays - 2));
      return [{ id: `du-${id}`, dayIndex: day, startHour: 12, endHour: 18, allDay: false }];
    }
    case 'high': {
      if (index % 6 !== 4) return [];
      const day = 2 + (index % Math.max(1, spanDays - 2));
      return [{ id: `du-${id}`, dayIndex: day, startHour: 8, endHour: 18, allDay: false }];
    }
    case 'very-high': {
      if (index % 4 !== 1) return [];
      const day = 1 + (index % Math.max(1, spanDays - 1));
      const endDay = Math.min(spanDays, day + 1);
      return [
        {
          id: `du-${id}`,
          dayIndex: day,
          endDayIndex: endDay,
          startHour: 14,
          endHour: 6,
          allDay: false,
        },
      ];
    }
  }
}

function buildPool(
  baseDate: Date,
  spanDays: number,
  poolSize: number,
  availability: AvailabilityPressure,
): Participant[] {
  const out: Participant[] = [];
  const dayMs = 24 * 3600000;
  for (let i = 0; i < poolSize; i++) {
    const spec = SPEC[i % SPEC.length];
    const id = `p${i + 1}`;
    const dateUnavailability = gapPolicy(availability, i, spanDays);
    out.push({
      id,
      name: `משתתף ${i + 1}`,
      level: spec.level,
      certifications: [...spec.certs],
      group: GROUPS[i % GROUPS.length],
      availability: [
        {
          start: new Date(baseDate.getTime() - dayMs),
          end: new Date(baseDate.getTime() + (spanDays + 1) * dayMs),
        },
      ],
      dateUnavailability,
    });
  }
  return out;
}

// ─── Task recipes ────────────────────────────────────────────────────────────

function attachSleepRecoveryToShemesh(tasks: Task[]): void {
  const rule: SleepRecoveryRule = { triggerShifts: [1], recoveryHours: 6 };
  for (const t of tasks) {
    if (t.sourceName === 'שמש') {
      t.sleepRecovery = { ...rule, triggerShifts: [...rule.triggerShifts] };
    }
  }
}

function reIdTasks(tasks: Task[]): Task[] {
  // Re-id so that scenarios with duplicated/filtered tasks keep unique ids
  // and slot ids. Mutates in place.
  let ti = 0;
  let si = 0;
  for (const t of tasks) {
    ti++;
    t.id = `t${ti}`;
    for (const s of t.slots) {
      si++;
      s.slotId = `s${si}`;
    }
  }
  return tasks;
}

function applyRecipe(tasks: Task[], recipe: TaskRecipe, baseDate: Date, days: number): Task[] {
  if (recipe === 'default') return tasks;

  if (recipe === 'lite') {
    return tasks.filter((t) => {
      if (t.sourceName === 'ערוגת בוקר' || t.sourceName === 'ערוגת ערב') return false;
      // Keep first 2 of 3 karov shifts per day
      if (t.sourceName === 'כרוב') {
        const dayMatch = /יום (\d+) /.exec(t.name);
        const day = dayMatch ? parseInt(dayMatch[1], 10) : 1;
        // Count current כרוב tasks for this day in input order — drop the 3rd
        return _karovKeep(tasks, day, t);
      }
      return true;
    });
  }

  if (recipe === 'heavy') {
    // Duplicate שמש: add a second occurrence at startHour+2 of every existing one
    const extras: Task[] = [];
    for (const t of tasks) {
      if (t.sourceName !== 'שמש') continue;
      const start = new Date(t.timeBlock.start.getTime() + 2 * 3600000);
      const end = new Date(start.getTime() + (t.timeBlock.end.getTime() - t.timeBlock.start.getTime()));
      extras.push({
        ...t,
        id: t.id + '-x',
        timeBlock: { start, end },
        name: t.name + ' x',
        slots: t.slots.map((s) => ({ ...s, slotId: s.slotId + '-x' })),
      });
    }
    return [...tasks, ...extras];
  }

  if (recipe === 'extra-shemesh-slots') {
    for (const t of tasks) {
      if (t.sourceName !== 'שמש') continue;
      t.slots.push({
        slotId: `${t.slots[0].slotId}-extra`,
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: ['Nitzan'],
        label: 'משתתף בשמש',
      });
      t.requiredCount = t.slots.length;
    }
    return tasks;
  }

  if (recipe === 'quality-opportunity') {
    // restRuleId only on every other שמש, creating uneven load potential
    let i = 0;
    for (const t of tasks) {
      if (t.sourceName !== 'שמש') continue;
      i++;
      if (i % 2 === 0) {
        delete (t as { restRuleId?: string }).restRuleId;
      }
    }
    return tasks;
  }

  if (recipe === 'split-focused') {
    // Drop sameGroup (אדנית) and Salsala-required (כרוב נהג is hard).
    // Keep שמש (HC-12+HC-14+HC-15), חממה (long shifts), ממטרה, ערוגות (short).
    // This is the cleanest world for testing split: every unfilled slot is
    // theoretically halvable, so Stage-4 and structuralRefine have real work.
    return tasks.filter(
      (t) =>
        t.sourceName === 'שמש' ||
        t.sourceName === 'חממה' ||
        t.sourceName === 'ממטרה' ||
        t.sourceName === 'ערוגת בוקר' ||
        t.sourceName === 'ערוגת ערב',
    );
  }

  if (recipe === 'tight-feasibility') {
    // Replace 6×4h שמש shifts/day with 3×8h שמש shifts/day, which is much
    // harder for one participant to cover whole — feasibility-split bait.
    const kept: Task[] = tasks.filter((t) => t.sourceName !== 'שמש');
    for (let day = 0; day < days; day++) {
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + day);
      const blocks = generateShiftBlocks(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0), 8, 3);
      let i = 0;
      for (const block of blocks) {
        i++;
        kept.push({
          id: `shemesh-tight-d${day + 1}-${i}`,
          name: `יום ${day + 1} שמש-ארוך ${i}`,
          sourceName: 'שמש',
          timeBlock: block,
          requiredCount: 2,
          slots: [
            {
              slotId: `tight-d${day + 1}-${i}-1`,
              acceptableLevels: [{ level: Level.L0 }],
              requiredCertifications: ['Nitzan'],
              label: 'משתתף בשמש',
            },
            {
              slotId: `tight-d${day + 1}-${i}-2`,
              acceptableLevels: [{ level: Level.L0 }],
              requiredCertifications: ['Nitzan'],
              label: 'משתתף בשמש',
            },
          ],
          sameGroupRequired: false,
          blocksConsecutive: true,
          restRuleId: 'demo-rest-rule',
        });
      }
    }
    return kept;
  }

  return tasks;
}

// Helper: keep first 2 of 3 karov tasks per day (drop the third by name suffix).
const _karovSeen = new Map<number, number>();
function _karovKeep(_all: Task[], day: number, _t: Task): boolean {
  const c = _karovSeen.get(day) ?? 0;
  _karovSeen.set(day, c + 1);
  return c < 2;
}
function resetKarovSeen(): void {
  _karovSeen.clear();
}

// ─── Splittable stamping ─────────────────────────────────────────────────────

function stampSplittable(tasks: Task[], set: SplittableSet): void {
  // Always start from clean false (in case tasks were pre-marked elsewhere).
  for (const t of tasks) (t as { splittable?: boolean }).splittable = false;
  if (set === 'none') return;
  let i = 0;
  for (const t of tasks) {
    if (set === 'all-non-sameGroup' && !t.sameGroupRequired) t.splittable = true;
    else if (set === 'shemesh-only' && t.sourceName === 'שמש') t.splittable = true;
    else if (set === 'half-non-sameGroup' && !t.sameGroupRequired) {
      i++;
      if (i % 2 === 1) t.splittable = true;
    } else if (set === 'all-incl-sameGroup') t.splittable = true;
  }
}

// ─── Build entry ─────────────────────────────────────────────────────────────

export function buildScenario(spec: ScenarioSpec): BuiltScenario {
  const baseDate = new Date(2026, 1, 16);
  resetKarovSeen();
  let tasks = generateWeeklyTasks(baseDate, spec.days);
  attachSleepRecoveryToShemesh(tasks);
  tasks = applyRecipe(tasks, spec.taskRecipe, baseDate, spec.days);
  if (spec.taskSourceFilter) tasks = tasks.filter((t) => spec.taskSourceFilter!(t.sourceName ?? t.name));
  reIdTasks(tasks);
  stampSplittable(tasks, spec.splittableSet);
  const participants = buildPool(baseDate, spec.days, spec.poolSize, spec.availability);
  return {
    spec,
    tasks,
    participants,
    baseDate,
    dayStartHour: 5,
    restRuleMap: new Map<string, number>([['demo-rest-rule', 5 * 3600000]]),
  };
}

// ─── Predefined scenario catalog ─────────────────────────────────────────────

/**
 * The canonical scenario list for the benchmark. Each entry varies one or two
 * dimensions from a baseline so the effect of each knob can be isolated.
 *
 * Naming convention: `<days>d-<pool>p-<recipe>-<avail>-<split>`. The OFF
 * twin of every scenario is implicit (we run the same scenario with
 * splittableSet='none' as the control).
 */
export interface ScenarioBundle {
  /** Pretty label for table headers. */
  label: string;
  /** ON spec (used for all splitPenalty cells). */
  on: ScenarioSpec;
  /** OFF spec (identical except splittableSet='none' — the matched control). */
  off: ScenarioSpec;
}

function pair(spec: ScenarioSpec, label: string): ScenarioBundle {
  // OFF shares the same `id` as ON so the analyzer can match them as a
  // single scenario; the `splittingOn` flag on each RunResult disambiguates.
  return {
    label,
    on: spec,
    off: { ...spec, splittableSet: 'none' },
  };
}

export const SCENARIOS: ScenarioBundle[] = [
  // ── Schedule length sweep (medium pool, default tasks, medium avail) ────
  pair(
    {
      id: '1d-54p-default-med',
      days: 1,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '1d · 54p · default · medAvail',
  ),
  pair(
    {
      id: '2d-54p-default-med',
      days: 2,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '2d · 54p · default · medAvail',
  ),
  pair(
    {
      id: '4d-54p-default-med',
      days: 4,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '4d · 54p · default · medAvail',
  ),
  pair(
    {
      id: '6d-54p-default-med',
      days: 6,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '6d · 54p · default · medAvail',
  ),
  pair(
    {
      id: '3d-54p-default-med',
      days: 3,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '3d · 54p · default · medAvail',
  ),
  pair(
    {
      id: '4d-54p-default-med',
      days: 4,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '4d · 54p · default · medAvail',
  ),
  pair(
    {
      id: '5d-54p-default-med',
      days: 5,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '5d · 54p · default · medAvail',
  ),
  pair(
    {
      id: '6d-54p-default-med',
      days: 6,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '6d · 54p · default · medAvail',
  ),
  pair(
    {
      id: '7d-54p-default-med',
      days: 7,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 54p · default · medAvail',
  ),

  // ── Pool size sweep (7 days, default tasks, medium avail) ───────────────
  pair(
    {
      id: '7d-40p-default-med',
      days: 7,
      poolSize: 40,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 40p · default · medAvail (overload)',
  ),
  pair(
    {
      id: '7d-48p-default-med',
      days: 7,
      poolSize: 48,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 48p · default · medAvail (tight)',
  ),
  pair(
    {
      id: '7d-60p-default-med',
      days: 7,
      poolSize: 60,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 60p · default · medAvail',
  ),
  pair(
    {
      id: '7d-72p-default-med',
      days: 7,
      poolSize: 72,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 72p · default · medAvail (slack)',
  ),
  pair(
    {
      id: '7d-84p-default-med',
      days: 7,
      poolSize: 84,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 84p · default · medAvail (loose)',
  ),

  // ── Task pressure sweep (7 days, 54p, medium avail) ─────────────────────
  pair(
    {
      id: '7d-54p-lite-med',
      days: 7,
      poolSize: 54,
      taskRecipe: 'lite',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 54p · lite · medAvail',
  ),
  pair(
    {
      id: '7d-54p-heavy-med',
      days: 7,
      poolSize: 54,
      taskRecipe: 'heavy',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 54p · heavy · medAvail',
  ),
  pair(
    {
      id: '7d-54p-extra-med',
      days: 7,
      poolSize: 54,
      taskRecipe: 'extra-shemesh-slots',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 54p · extra-shemesh-slots · medAvail',
  ),
  pair(
    {
      id: '7d-54p-quality-med',
      days: 7,
      poolSize: 54,
      taskRecipe: 'quality-opportunity',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 54p · quality-opportunity · medAvail',
  ),
  pair(
    {
      id: '7d-54p-tight-med',
      days: 7,
      poolSize: 54,
      taskRecipe: 'tight-feasibility',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 54p · tight-feasibility · medAvail',
  ),

  // ── Availability pressure sweep (7d, 54p, default) ──────────────────────
  pair(
    {
      id: '7d-54p-default-none',
      days: 7,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'none',
    },
    '7d · 54p · default · noAvail',
  ),
  pair(
    {
      id: '7d-54p-default-low',
      days: 7,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'low',
    },
    '7d · 54p · default · lowAvail',
  ),
  pair(
    {
      id: '7d-54p-default-high',
      days: 7,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'high',
    },
    '7d · 54p · default · highAvail',
  ),
  pair(
    {
      id: '7d-54p-default-vh',
      days: 7,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-non-sameGroup',
      availability: 'very-high',
    },
    '7d · 54p · default · veryHighAvail',
  ),

  // ── Splittable selectivity sweep (7d, 54p, default, med) ────────────────
  pair(
    {
      id: '7d-54p-default-med-shemesh',
      days: 7,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'shemesh-only',
      availability: 'medium',
    },
    '7d · 54p · default · medAvail · split=shemesh-only',
  ),
  pair(
    {
      id: '7d-54p-default-med-half',
      days: 7,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'half-non-sameGroup',
      availability: 'medium',
    },
    '7d · 54p · default · medAvail · split=half',
  ),
  pair(
    {
      id: '7d-54p-default-med-all',
      days: 7,
      poolSize: 54,
      taskRecipe: 'default',
      splittableSet: 'all-incl-sameGroup',
      availability: 'medium',
    },
    '7d · 54p · default · medAvail · split=all-incl-sameGroup',
  ),

  // ── Stress: overload + tight feasibility + high avail ───────────────────
  pair(
    {
      id: '7d-48p-tight-high',
      days: 7,
      poolSize: 48,
      taskRecipe: 'tight-feasibility',
      splittableSet: 'all-non-sameGroup',
      availability: 'high',
    },
    '7d · 48p · tight-feasibility · highAvail (stress)',
  ),

  // ── Slack: large pool + lite tasks + no avail (quality-side test) ───────
  pair(
    {
      id: '7d-72p-lite-none',
      days: 7,
      poolSize: 72,
      taskRecipe: 'lite',
      splittableSet: 'all-non-sameGroup',
      availability: 'none',
    },
    '7d · 72p · lite · noAvail (slack, quality)',
  ),

  // ── Split-focused: drop same-group + Salsala-required so splits matter ───
  // These are the scenarios where shift-splitting is *exercised* — non-trivial
  // load with no feasibility blockers from sameGroup / missing certs.
  pair(
    {
      id: '7d-18p-splitfoc-med',
      days: 7,
      poolSize: 18,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 18p · split-focused · medAvail (very tight)',
  ),
  pair(
    {
      id: '7d-22p-splitfoc-med',
      days: 7,
      poolSize: 22,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 22p · split-focused · medAvail (tight)',
  ),
  pair(
    {
      id: '7d-26p-splitfoc-med',
      days: 7,
      poolSize: 26,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 26p · split-focused · medAvail',
  ),
  pair(
    {
      id: '7d-30p-splitfoc-med',
      days: 7,
      poolSize: 30,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 30p · split-focused · medAvail',
  ),
  pair(
    {
      id: '7d-36p-splitfoc-med',
      days: 7,
      poolSize: 36,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '7d · 36p · split-focused · medAvail',
  ),
  pair(
    {
      id: '7d-22p-splitfoc-high',
      days: 7,
      poolSize: 22,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'high',
    },
    '7d · 22p · split-focused · highAvail',
  ),
  pair(
    {
      id: '7d-30p-splitfoc-high',
      days: 7,
      poolSize: 30,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'high',
    },
    '7d · 30p · split-focused · highAvail',
  ),
  pair(
    {
      id: '5d-22p-splitfoc-med',
      days: 5,
      poolSize: 22,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '5d · 22p · split-focused · medAvail',
  ),
  pair(
    {
      id: '5d-30p-splitfoc-med',
      days: 5,
      poolSize: 30,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '5d · 30p · split-focused · medAvail',
  ),
  pair(
    {
      id: '3d-22p-splitfoc-med',
      days: 3,
      poolSize: 22,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '3d · 22p · split-focused · medAvail',
  ),
  pair(
    {
      id: '2d-22p-splitfoc-med',
      days: 2,
      poolSize: 22,
      taskRecipe: 'split-focused',
      splittableSet: 'all-non-sameGroup',
      availability: 'medium',
    },
    '2d · 22p · split-focused · medAvail',
  ),
];

/**
 * Tier-1 reconnaissance: broad coverage. Includes default-54p (no-regression
 * baseline), default-med variants (schedule length / pool / pressure /
 * availability sweeps), splittable selectivity, AND split-focused scenarios
 * where splits actually happen — without those the splitting feature gets
 * benchmarked against an environment where it can never act.
 */
export const TIER1_IDS = new Set<string>([
  // Regression: default scenarios where splitting rarely fires
  '7d-54p-default-med',
  '7d-48p-default-med',
  '7d-72p-default-med',
  '7d-54p-lite-med',
  '7d-54p-default-high',
  // Schedule length sweep
  '3d-54p-default-med',
  '5d-54p-default-med',
  // Splittable selectivity
  '7d-54p-default-med-half',
  // Split-focused scenarios (where structuralRefine and Stage-4 actually act)
  '7d-22p-splitfoc-med',
  '7d-26p-splitfoc-med',
  '7d-30p-splitfoc-med',
  '7d-22p-splitfoc-high',
  '5d-22p-splitfoc-med',
  '3d-22p-splitfoc-med',
]);

/** Tier-1b supplement: schedule lengths and availability extremes not in Tier 1. */
export const TIER1B_IDS = new Set<string>([
  '1d-54p-default-med',
  '2d-54p-default-med',
  '4d-54p-default-med',
  '6d-54p-default-med',
  '7d-54p-default-none', // no availability gaps
  '7d-54p-default-low', // low availability pressure
  '7d-54p-default-vh', // very-high availability pressure
  '7d-72p-lite-none', // slack
  '7d-84p-default-med', // very loose pool
  '7d-40p-default-med', // overload (smaller default pool)
  '7d-54p-heavy-med',
  '7d-54p-quality-med',
  '7d-54p-default-med-shemesh', // shemesh-only splittable
  '7d-54p-default-med-all', // all-incl-sameGroup splittable
  '7d-48p-tight-high', // stress
  '5d-30p-splitfoc-med',
  '7d-36p-splitfoc-med',
  '7d-30p-splitfoc-high',
  '2d-22p-splitfoc-med',
]);

/** Tier-2 deep dive: focused 6-scenario subset for the dense splitPenalty grid.
 *  Smaller than Tier 1 to fit the 60-attempt budget; spans tight/loose/pressure
 *  variants and one no-regression check. */
export const TIER2_IDS = new Set<string>([
  '7d-22p-splitfoc-med', // tight, splits fire often
  '7d-30p-splitfoc-med', // less tight
  '7d-22p-splitfoc-high', // tight + availability pressure
  '5d-22p-splitfoc-med', // shorter schedule
  '7d-54p-tight-med', // production-like tight feasibility
  '7d-54p-default-med', // no-regression check at default 54p
]);

/** Tier-3 MAX_STRUCTURAL_PASSES sweep — scenarios where structuralRefine actually fires. */
export const TIER3_IDS = new Set<string>([
  '7d-18p-splitfoc-med',
  '7d-22p-splitfoc-med',
  '7d-30p-splitfoc-med',
  '7d-22p-splitfoc-high',
  '5d-22p-splitfoc-med',
]);
