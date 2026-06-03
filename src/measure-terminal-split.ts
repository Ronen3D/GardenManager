/**
 * Terminal-split fallback — ACTIVATION measurement (post-implementation).
 *
 * ⚠️ HISTORY / WHAT THIS IS NOT:
 * This harness began as the PRE-implementation investigation that established
 * the terminal chain-internal split is a real-but-~0%-base-rate mechanism. That
 * feature has since SHIPPED — `generateRescuePlans` now produces these plans
 * itself (rescue.ts `enumerateTerminalSplitCandidatesForRescue`, surfaced as a
 * `RescuePlan.terminalSplit` fallback). The old "would a terminal split help?"
 * probe is therefore OBSOLETE and was removed: with the feature live, any
 * "pure rescue returned 0 plans" baseline is confounded (the fallback absorbs
 * exactly those cases), so it can no longer prove a *unique unlock*. The
 * original 0%-base-rate finding is preserved in git history + the design notes.
 *
 * WHAT THIS MEASURES NOW (accurately): the SHIPPED behavior. Across the real
 * default-store data (+ optional synthetic fixtures) it vacates every modifiable
 * assignment, runs the real `generateRescuePlans`, and classifies the outcome:
 *   - terminalFired : a `terminalSplit` plan was surfaced (the fallback fired)
 *   - pureRescued   : ≥1 plan, none terminal (ordinary rescue handled it)
 *   - infeasible    : 0 plans (no rescue even with the fallback)
 * Output = the fallback ACTIVATION RATE on realistic schedules (expected ~0,
 * consistent with the base-rate finding) + a positive CONTROL proving the
 * fallback fires end-to-end when its precondition is actually met.
 *
 * This is a coverage / activation / latency probe — NOT a correctness gate.
 * Feature correctness is owned by `src/test-terminal-split-rescue.ts` (in
 * `npm test`). Excluded from the node build (see tsconfig.json); runs under the
 * bench tsconfig because it drives the (web) config-store for the default data.
 *
 * Run:
 *   npx ts-node --project tsconfig.bench-priority.json src/measure-terminal-split.ts
 *   (env: MEASURE_SEEDS, MEASURE_BASE_SEED, MEASURE_FIXTURES, MEASURE_MAX_SLOTS,
 *         MEASURE_SPLITTABLE=all|none, MEASURE_BENCH=1 to also run the synthetic sweep)
 */

// ─── localStorage shim — defensive, mirrors bench-priority/runner.ts ──────────
{
  const mem: Record<string, string> = {};
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (k in mem ? mem[k] : null),
    setItem: (k: string, v: string) => {
      mem[k] = String(v);
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
    clear: () => {
      for (const k of Object.keys(mem)) delete mem[k];
    },
    get length() {
      return Object.keys(mem).length;
    },
    key: (i: number) => Object.keys(mem)[i] ?? null,
  } as Storage;
}

import * as fs from 'fs';
import * as path from 'path';

import { ALL_FIXTURES } from './bench-priority/fixtures';
import { makeParticipant, makeSlot, makeTask } from './bench-priority/fixtures/shared';
import { withSeededRandom } from './bench-split-tuning/seeded-rng';
import { generateRescuePlans } from './engine/rescue';
import { SchedulingEngine } from './engine/scheduler';
import { isModifiableAssignment } from './engine/temporal';
import {
  type Assignment,
  DEFAULT_CONFIG,
  Level,
  type Participant,
  type Schedule,
  type SchedulerConfig,
  type SlotRequirement,
  type Task,
} from './models/types';
import { computeTemplateSectionKey } from './shared/layout-key';
import { generateShiftBlocks, hourInOpDay } from './shared/utils/time-utils';
import {
  buildRestRuleMap,
  getAllParticipants,
  getAllTaskTemplates,
  getDayStartHour,
  getScheduleDate,
  getScheduleDays,
  initStore,
} from './web/config-store';

// ─── Per-scenario activation classification ───────────────────────────────────

interface ScenarioStats {
  id: string;
  probed: number;
  terminalFired: number; // generateRescuePlans surfaced a terminalSplit plan
  pureRescued: number; // ≥1 plan, none terminal
  infeasible: number; // 0 plans (no rescue even with the fallback)
  examples: string[];
}

function emptyStats(id: string): ScenarioStats {
  return { id, probed: 0, terminalFired: 0, pureRescued: 0, infeasible: 0, examples: [] };
}

/**
 * Vacate every modifiable assignment of a generated schedule, run the REAL
 * rescue planner, and classify whether the shipped terminal-split fallback
 * fired. Bounded by MEASURE_MAX_SLOTS to keep heavy fixtures tractable.
 */
function measureScenario(id: string, schedule: Schedule, anchor: Date, eng: SchedulingEngine): ScenarioStats {
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);
  const maxSlots = Number(process.env.MEASURE_MAX_SLOTS ?? 60);
  const config = eng.getConfig();
  const scoreCtx = eng.buildScoreContext(); // must be defined for the fallback to be reachable
  const stats = emptyStats(id);

  for (const Av of schedule.assignments) {
    if (stats.probed >= maxSlots) break;
    const task = taskMap.get(Av.taskId);
    if (!task) continue;
    if (!isModifiableAssignment(Av, taskMap, anchor)) continue;
    if (task.splitGroupId !== undefined) continue; // skip already-split fragments
    stats.probed++;

    const res = generateRescuePlans(
      schedule,
      { vacatedAssignmentId: Av.id, taskId: Av.taskId, slotId: Av.slotId, vacatedBy: Av.participantId },
      anchor,
      0,
      5,
      eng.getDisabledHC(),
      eng.getRestRuleMap(),
      eng.getDayStartHour(),
      eng.getCertLabelResolver(),
      config,
      scoreCtx,
      eng.getScheduleContext(),
    );
    const terminal = res.plans.find((p) => p.terminalSplit === true);
    if (terminal) {
      stats.terminalFired++;
      if (stats.examples.length < 8) {
        const op = terminal.splitOps?.[0];
        stats.examples.push(
          `[FIRED] vacate ${Av.participantId}@${task.name} → ${terminal.swaps[0]?.toParticipantId}; ` +
            `split ${op?.taskName} = {${op?.fillA.participantId},${op?.fillB.participantId}}`,
        );
      }
    } else if (res.plans.length > 0) {
      stats.pureRescued++;
    } else {
      stats.infeasible++;
    }
  }
  return stats;
}

// ─── Default-store scenarios (real production reference data) ─────────────────

interface Scenario {
  id: string;
  mkTasks: () => Task[];
  participants: Participant[];
  restRuleMap?: Map<string, number>;
  dayStartHour: number;
}

let _slotN = 0;
let _taskN = 0;

/**
 * Instantiate tasks from the real default TaskTemplates — a faithful (slightly
 * simplified) replica of app.ts:generateTasksFromTemplates. forceSplitAll=true
 * marks every multi-hour task splittable (upper-bound opportunity); false
 * respects the template's own `splittable` flag (true production default —
 * only חממה/Hamama opts in).
 */
function instantiateTasks(
  templates: ReturnType<typeof getAllTaskTemplates>,
  numDays: number,
  baseDate: Date,
  dayStartHour: number,
  forceSplitAll: boolean,
): Task[] {
  const out: Task[] = [];
  _slotN = 0;
  _taskN = 0;
  for (let d = 0; d < numDays; d++) {
    const dayLabel = `D${d + 1}`;
    for (const tpl of templates) {
      if (tpl.shiftsPerDay < 1 || tpl.durationHours <= 0) continue;
      const startDate = new Date(hourInOpDay(baseDate, dayStartHour, d + 1, tpl.startHour));
      const shifts =
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
              slotId: `${tpl.name.toLowerCase()}-slot-${++_slotN}`,
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
            slotId: `${tpl.name.toLowerCase()}-slot-${++_slotN}`,
            acceptableLevels: [...s.acceptableLevels],
            requiredCertifications: [...s.requiredCertifications],
            forbiddenCertifications: s.forbiddenCertifications ? [...s.forbiddenCertifications] : undefined,
            label: s.label,
          });
        }
        if (slots.length === 0) continue;
        const durMs = block.end.getTime() - block.start.getTime();
        out.push({
          id: `${tpl.name.toLowerCase()}-d${d + 1}-${++_taskN}`,
          name: `${dayLabel} ${tpl.name}${tpl.shiftsPerDay > 1 ? ` משמרת ${si + 1}` : ''}`,
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
          splittable: forceSplitAll ? durMs >= 2 * 60_000 : (tpl.splittable ?? false),
        });
      }
    }
  }
  return out;
}

function removeL0PerGroup(parts: Participant[], n: number): Participant[] {
  if (n <= 0) return parts;
  const byGroup = new Map<string, Participant[]>();
  for (const p of parts) {
    let g = byGroup.get(p.group);
    if (!g) {
      g = [];
      byGroup.set(p.group, g);
    }
    g.push(p);
  }
  const removed = new Set<string>();
  for (const members of byGroup.values()) {
    const l0s = members.filter((p) => p.level === Level.L0);
    for (let i = 0; i < n && i < l0s.length; i++) removed.add(l0s[i].id);
  }
  return parts.filter((p) => !removed.has(p.id));
}

function buildDefaultScenarios(): Scenario[] {
  initStore(); // seeds default participants + task templates into the (shimmed) store
  const templates = getAllTaskTemplates();
  const allParts = getAllParticipants().map((p) => structuredClone(p));
  const numDays = getScheduleDays();
  const baseDate = getScheduleDate();
  const dayStartHour = getDayStartHour();
  const restRuleMap = buildRestRuleMap();

  const mk = (forceSplitAll: boolean) => () =>
    instantiateTasks(templates, numDays, baseDate, dayStartHour, forceSplitAll);
  const scenarios: Scenario[] = [];
  for (const [tag, n] of [
    ['spacious', 0],
    ['tight2', 2],
    ['tight4', 4],
  ] as const) {
    const parts = removeL0PerGroup(allParts, n);
    scenarios.push({ id: `default-${tag}-realistic`, mkTasks: mk(false), participants: parts, restRuleMap, dayStartHour });
    scenarios.push({ id: `default-${tag}-allsplit`, mkTasks: mk(true), participants: parts, restRuleMap, dayStartHour });
  }
  return scenarios;
}

function runDefaultScenarios(): ScenarioStats[] {
  const seedCount = Number(process.env.MEASURE_SEEDS ?? 3);
  const baseSeed = Number(process.env.MEASURE_BASE_SEED ?? 3000);
  const scenarios = buildDefaultScenarios();
  const out: ScenarioStats[] = [];
  for (const sc of scenarios) {
    const agg = emptyStats(sc.id);
    let unfilledTotal = 0;
    let slotsTotal = 0;
    for (let i = 0; i < seedCount; i++) {
      const seed = baseSeed + i;
      const tasks = sc.mkTasks();
      slotsTotal += tasks.reduce((s, t) => s + t.slots.length, 0);
      const eng = new SchedulingEngine({ ...DEFAULT_CONFIG }, undefined, sc.restRuleMap, sc.dayStartHour, 'quality');
      eng.addParticipants(sc.participants);
      eng.addTasks(tasks);
      const schedule = withSeededRandom(seed, () => eng.generateSchedule());
      unfilledTotal += schedule.tasks.reduce((s, t) => s + t.slots.length, 0) - schedule.assignments.length;
      const anchor = new Date(schedule.periodStart.getTime() - 3600_000);
      const s = measureScenario(sc.id, schedule, anchor, eng);
      agg.probed += s.probed;
      agg.terminalFired += s.terminalFired;
      agg.pureRescued += s.pureRescued;
      agg.infeasible += s.infeasible;
      for (const ex of s.examples) if (agg.examples.length < 8) agg.examples.push(`s${seed}: ${ex}`);
    }
    out.push(agg);
    console.log(
      `[${sc.id}] parts=${sc.participants.length} slots≈${Math.round(slotsTotal / seedCount)} unfilled≈${Math.round(unfilledTotal / seedCount)} ` +
        `probed=${agg.probed} terminalFired=${agg.terminalFired} pureRescued=${agg.pureRescued} infeasible=${agg.infeasible}`,
    );
    for (const ex of agg.examples.slice(0, 4)) console.log(`     ${ex}`);
  }
  return out;
}

// ─── Synthetic bench-priority sweep (optional breadth) ────────────────────────

function forceSplittable(tasks: Task[], mode: 'all' | 'none'): void {
  if (mode === 'none') return;
  for (const t of tasks) {
    const durMs = t.timeBlock.end.getTime() - t.timeBlock.start.getTime();
    if (durMs >= 2 * 60_000) t.splittable = true;
  }
}

function runSweep(): ScenarioStats[] {
  const seedCount = Number(process.env.MEASURE_SEEDS ?? 4);
  const baseSeed = Number(process.env.MEASURE_BASE_SEED ?? 2000);
  const splitMode = (process.env.MEASURE_SPLITTABLE ?? 'all') as 'all' | 'none';
  const filter = process.env.MEASURE_FIXTURES?.split(',').map((s) => s.trim());
  const fixtures = ALL_FIXTURES.filter((f) => !filter || filter.includes(f.id));

  const out: ScenarioStats[] = [];
  for (const fx of fixtures) {
    const agg = emptyStats(fx.id);
    for (let i = 0; i < seedCount; i++) {
      const seed = baseSeed + i;
      const inst = fx.generate(seed);
      forceSplittable(inst.tasks, splitMode);
      const eng = new SchedulingEngine(inst.config, undefined, inst.restRuleMap, inst.dayStartHour, 'quality');
      eng.addParticipants(inst.participants);
      eng.addTasks(inst.tasks);
      const schedule = withSeededRandom(seed, () => eng.generateSchedule());
      const anchor = new Date(schedule.periodStart.getTime() - 3600_000);
      const s = measureScenario(fx.id, schedule, anchor, eng);
      agg.probed += s.probed;
      agg.terminalFired += s.terminalFired;
      agg.pureRescued += s.pureRescued;
      agg.infeasible += s.infeasible;
      for (const ex of s.examples) if (agg.examples.length < 8) agg.examples.push(`s${seed}: ${ex}`);
    }
    out.push(agg);
    console.log(
      `[${fx.id}] probed=${agg.probed} terminalFired=${agg.terminalFired} ` +
        `pureRescued=${agg.pureRescued} infeasible=${agg.infeasible}`,
    );
    for (const ex of agg.examples.slice(0, 3)) console.log(`     ${ex}`);
  }
  return out;
}

// ─── Positive control: the fallback fires end-to-end when its precondition holds

function positiveControl(): { fired: boolean; planCount: number; detail: string } {
  const base = new Date(2026, 4, 25);
  // V and T overlap 08:00–12:00 so pStar (the only cv-holder besides the
  // departing pGone) must vacate T to take V; T then has no single whole-avail
  // ck-holder (aHalf=08–10 only, bHalf=10–12 only) ⇒ only a terminal split fills it.
  const day1 = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const avail = (sh: number, eh: number) => [
    { start: new Date(day1.getTime() + sh * 3600_000), end: new Date(day1.getTime() + eh * 3600_000) },
  ];

  const pStar = makeParticipant({ id: 'pStar', level: Level.L3, certs: ['cv', 'ck'], group: 'G', availability: avail(0, 24) });
  const pGone = makeParticipant({ id: 'pGone', level: Level.L3, certs: ['cv'], group: 'G', availability: avail(0, 24) });
  const a = makeParticipant({ id: 'aHalf', level: Level.L2, certs: ['ck'], group: 'G', availability: avail(8, 10) });
  const b = makeParticipant({ id: 'bHalf', level: Level.L2, certs: ['ck'], group: 'G', availability: avail(10, 12) });

  const T = makeTask({
    name: 'DonorT', baseDate: base, dayIndex: 1, startHour: 8, durationHours: 4, splittable: true,
    slots: [makeSlot({ acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }], requiredCertifications: ['ck'], label: 'T' })],
  });
  const V = makeTask({
    name: 'SlotV', baseDate: base, dayIndex: 1, startHour: 8, durationHours: 4, splittable: false,
    slots: [makeSlot({ acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }], requiredCertifications: ['cv'], label: 'V' })],
  });

  // High splitPenalty so generation never gratuitously splits the donor.
  const ctlConfig: SchedulerConfig = { ...DEFAULT_CONFIG, splitPenalty: 1000 };

  // Seed-search for the intended pre-state: pStar whole on T, pGone on V, T not split.
  let schedule: Schedule | null = null;
  let vAsg: Assignment | undefined;
  for (let seed = 0; seed < 40 && !schedule; seed++) {
    const eng0 = new SchedulingEngine({ ...ctlConfig }, undefined, undefined, 5, 'quality');
    eng0.addParticipants([pStar, pGone, a, b]);
    eng0.addTasks([T, V]);
    const s = withSeededRandom(seed, () => eng0.generateSchedule());
    const va = s.assignments.find((x) => x.taskId === V.id);
    const ta = s.assignments.find((x) => x.taskId === T.id);
    if (va && ta && ta.participantId === 'pStar' && va.participantId === 'pGone') {
      schedule = s;
      vAsg = va;
    }
  }
  if (!schedule || !vAsg) {
    return { fired: false, planCount: -1, detail: 'control: no seed produced the target pre-state (setup invalid)' };
  }

  const eng = new SchedulingEngine({ ...ctlConfig }, undefined, undefined, 5, 'quality');
  eng.addParticipants([pStar, pGone, a, b]);
  eng.addTasks([T, V]);
  void eng.generateSchedule(); // re-point eng getters/scoreCtx at consistent state

  const anchor = new Date(schedule.periodStart.getTime() - 3600_000);
  const res = generateRescuePlans(
    schedule,
    { vacatedAssignmentId: vAsg.id, taskId: vAsg.taskId, slotId: vAsg.slotId, vacatedBy: vAsg.participantId },
    anchor,
    0,
    5,
    eng.getDisabledHC(),
    eng.getRestRuleMap(),
    eng.getDayStartHour(),
    eng.getCertLabelResolver(),
    eng.getConfig(),
    eng.buildScoreContext(),
    eng.getScheduleContext(),
  );
  const terminal = res.plans.find((p) => p.terminalSplit === true);
  const op = terminal?.splitOps?.[0];
  return {
    fired: terminal !== undefined,
    planCount: res.plans.length,
    detail: terminal
      ? `${terminal.swaps[0]?.toParticipantId}→V ; split ${op?.taskName} = {${op?.fillA.participantId},${op?.fillB.participantId}}`
      : '(no terminal-split plan surfaced)',
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  if (d === 0) return '0%';
  return `${((100 * n) / d).toFixed(2)}%`;
}

function main(): void {
  console.log('═'.repeat(74));
  console.log('Terminal-split fallback — ACTIVATION measurement (shipped behavior)');
  console.log('═'.repeat(74));

  console.log('\n── Positive control (does the shipped fallback fire end-to-end?) ──');
  const ctl = positiveControl();
  console.log(`  planCount=${ctl.planCount}  terminalSplitFired=${ctl.fired}`);
  console.log(`  ${ctl.detail}`);
  console.log(
    ctl.fired
      ? '  ✓ generateRescuePlans surfaces the terminal-split plan when its precondition is met.'
      : '  ⚠️  CONTROL FAILED — the shipped fallback did not fire on a known-good scenario.',
  );

  console.log('\n── Default-store scenarios (real production reference data) ──');
  const defaults = runDefaultScenarios();

  const benchOn = process.env.MEASURE_BENCH === '1';
  console.log(`\n── Synthetic bench-priority sweep ${benchOn ? '' : '(skipped — set MEASURE_BENCH=1)'} ──`);
  const sweep = benchOn ? runSweep() : [];

  const all = [...defaults, ...sweep];
  const probed = all.reduce((s, x) => s + x.probed, 0);
  const fired = all.reduce((s, x) => s + x.terminalFired, 0);
  const pureRescued = all.reduce((s, x) => s + x.pureRescued, 0);
  const infeasible = all.reduce((s, x) => s + x.infeasible, 0);
  const defProbed = defaults.reduce((s, x) => s + x.probed, 0);
  const defFired = defaults.reduce((s, x) => s + x.terminalFired, 0);

  console.log('\n── Summary (activation of the shipped fallback) ──');
  console.log(`  total vacancies probed          : ${probed}`);
  console.log(`  ↳ terminal-split FIRED          : ${fired}  (${pct(fired, probed)} of all)`);
  console.log(`  ↳ ordinary rescue handled it    : ${pureRescued}`);
  console.log(`  ↳ infeasible (no plan at all)   : ${infeasible}`);
  console.log(`  default-store activation rate   : ${defFired} / ${defProbed}  (${pct(defFired, defProbed)})`);
  console.log(
    '  NOTE: ~0% on realistic data is the EXPECTED result (the precondition rarely arises);\n' +
      '  the control above proves the fallback works when it does. Correctness ⇒ test-terminal-split-rescue.ts.',
  );

  const outDir = 'tmp';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const report = {
    purpose: 'post-implementation activation measurement of the shipped terminal-split rescue fallback',
    control: ctl,
    defaultScenarios: defaults,
    benchFixtures: sweep,
    totals: { probed, fired, pureRescued, infeasible, defProbed, defFired },
  };
  fs.writeFileSync(path.join(outDir, 'terminal-split-measure.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nWrote tmp/terminal-split-measure.json`);
}

main();
