/**
 * Shared helpers for building synthetic fixtures.
 *
 * Fixtures are deterministic: same seed ⇒ byte-identical participants/tasks.
 * That property is required for paired-Δ comparison across variants in the
 * bench runner.
 *
 * The helpers below cover the common construction shapes: making
 * participants with specific (level, certs, group), making tasks with
 * specific shifts/slots/duration, and wide availability windows that span
 * the whole period.
 */

import { addDays, addHours, startOfDay } from 'date-fns';

import {
  AssignmentStatus as _AssignmentStatus,
  type AvailabilityWindow,
  type DateUnavailability,
  DEFAULT_CONFIG,
  type Level,
  type LevelEntry,
  type Participant,
  type SchedulerConfig,
  type SleepRecoveryRule,
  type SlotRequirement,
  type Task,
} from '../../models/types';
import { createTimeBlockFromHours } from '../../shared/utils/time-utils';

// Suppress unused-import linter (kept for symmetry with the patterns in
// other benches — we may need AssignmentStatus when extending pinned-input
// fixtures in a future phase).
void _AssignmentStatus;

// ─── Seeded RNG (Mulberry32) ─────────────────────────────────────────────────

/**
 * Stand-alone Mulberry32 — independent of the optimizer's monkey-patched
 * Math.random. Used inside fixture generators where we need deterministic
 * randomness without disturbing the engine's global RNG state.
 */
export function makeMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick a random element using the supplied rng (in-place safe). */
export function pickOne<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fisher-Yates shuffle in place using the supplied rng. Returns the array. */
export function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Period anchor ────────────────────────────────────────────────────────────

/**
 * Bench-stable base date. We pick a Monday in mid-2026 so periodDays=7
 * never spans a daylight-savings boundary in any common locale.
 */
export const DEFAULT_BASE_DATE = new Date(2026, 4, 25); // 2026-05-25 (Monday)

export function wideAvailability(baseDate: Date, periodDays: number): AvailabilityWindow[] {
  // Cover [dayStart, dayStart + (periodDays+1) days] so overnight tasks on
  // the last op-day still have an availability window.
  const dayStart = startOfDay(baseDate);
  return [
    {
      start: dayStart,
      end: addDays(dayStart, periodDays + 1),
    },
  ];
}

/**
 * Narrow availability window — used by fixture-availability-tight.
 * Returns participants available only for a specific hour range on a
 * specific day index.
 */
export function narrowAvailability(
  baseDate: Date,
  dayIndex: number,
  startHour: number,
  endHour: number,
): AvailabilityWindow[] {
  const dayStart = startOfDay(baseDate);
  const start = addHours(addDays(dayStart, dayIndex - 1), startHour);
  const end = addHours(addDays(dayStart, dayIndex - 1), endHour);
  return [{ start, end }];
}

// ─── Participant builder ─────────────────────────────────────────────────────

export interface MakeParticipantOpts {
  id: string;
  name?: string;
  level: Level;
  certs?: string[];
  group: string;
  availability?: AvailabilityWindow[];
  dateUnavailability?: DateUnavailability[];
  preferredTaskName?: string;
  lessPreferredTaskName?: string;
  workloadMultiplier?: number;
  notWithIds?: string[];
}

export function makeParticipant(opts: MakeParticipantOpts): Participant {
  return {
    id: opts.id,
    name: opts.name ?? opts.id,
    level: opts.level,
    certifications: opts.certs ?? [],
    group: opts.group,
    availability: opts.availability ?? wideAvailability(DEFAULT_BASE_DATE, 7),
    dateUnavailability: opts.dateUnavailability ?? [],
    notWithIds: opts.notWithIds,
    preferredTaskName: opts.preferredTaskName,
    lessPreferredTaskName: opts.lessPreferredTaskName,
    workloadMultiplier: opts.workloadMultiplier,
  };
}

// ─── Slot / Task builders ────────────────────────────────────────────────────

let _slotCounter = 0;
let _taskCounter = 0;

/** Reset slot/task id counters. Call at the top of each fixture generator
 *  for determinism. */
export function resetIdCounters(): void {
  _slotCounter = 0;
  _taskCounter = 0;
}

export interface MakeSlotOpts {
  acceptableLevels: LevelEntry[];
  requiredCertifications?: string[];
  forbiddenCertifications?: string[];
  label?: string;
}

export function makeSlot(opts: MakeSlotOpts): SlotRequirement {
  _slotCounter += 1;
  return {
    slotId: `slot-${_slotCounter}`,
    acceptableLevels: opts.acceptableLevels,
    requiredCertifications: opts.requiredCertifications ?? [],
    forbiddenCertifications: opts.forbiddenCertifications,
    label: opts.label ?? `slot-${_slotCounter}`,
  };
}

export interface MakeTaskOpts {
  /** Optional explicit id (default: auto-generated). */
  id?: string;
  name: string;
  /** sourceName for preference matching. */
  sourceName?: string;
  baseDate: Date;
  /** Operational day index (1-based). */
  dayIndex: number;
  /** Start hour 0-23 on the op-day. */
  startHour: number;
  /** Duration in hours. */
  durationHours: number;
  /** 1-based shift index. */
  shiftIndex?: number;
  slots: SlotRequirement[];
  sameGroupRequired?: boolean;
  blocksConsecutive?: boolean;
  restRuleId?: string;
  sleepRecovery?: SleepRecoveryRule;
  baseLoadWeight?: number;
  togethernessRelevant?: boolean;
  splittable?: boolean;
  /** Override schedulingPriority. */
  schedulingPriority?: number;
}

export function makeTask(opts: MakeTaskOpts): Task {
  _taskCounter += 1;
  const id = opts.id ?? `t-${_taskCounter}`;
  // Anchor the time block to (baseDate + (dayIndex-1) days).
  const dayBase = addDays(startOfDay(opts.baseDate), opts.dayIndex - 1);
  const timeBlock = createTimeBlockFromHours(
    dayBase,
    opts.startHour,
    opts.startHour + opts.durationHours,
    opts.durationHours,
  );
  return {
    id,
    name: opts.name,
    sourceName: opts.sourceName ?? opts.name,
    timeBlock,
    requiredCount: opts.slots.length,
    slots: opts.slots,
    sameGroupRequired: opts.sameGroupRequired ?? false,
    blocksConsecutive: opts.blocksConsecutive ?? false,
    schedulingPriority: opts.schedulingPriority,
    togethernessRelevant: opts.togethernessRelevant,
    restRuleId: opts.restRuleId,
    sleepRecovery: opts.sleepRecovery,
    shiftIndex: opts.shiftIndex ?? 1,
    baseLoadWeight: opts.baseLoadWeight,
    splittable: opts.splittable,
  };
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function defaultBenchConfig(): SchedulerConfig {
  // Use the production default. Individual fixtures can override fields
  // by spreading on top of this.
  return { ...DEFAULT_CONFIG };
}
