/**
 * Task Library - Factory functions to create properly-typed Task instances
 * with all slot requirements and constraints.
 */

import {
  Task,
  TaskType,
  SlotRequirement,
  Level,
  Certification,
  AdanitTeam,
  TimeBlock,
} from '../models/types';
import { generateShiftBlocks, createTimeBlockFromHours } from '../web/utils/time-utils';

let _slotCounter = 0;
function nextSlotId(prefix: string): string {
  return `${prefix}-slot-${++_slotCounter}`;
}

let _taskCounter = 0;
function nextTaskId(prefix: string): string {
  return `${prefix}-${++_taskCounter}`;
}

/** Reset slot counter — call at the start of each generation pass. */
export function resetSlotCounter(): void { _slotCounter = 0; }
/** Reset task counter — call at the start of each generation pass. */
export function resetTaskCounter(): void { _taskCounter = 0; }

// ─── Adanit ──────────────────────────────────────────────────────────────────
// 8h, 3 shifts per day (05:00 cycle). 2 teams (Segol Main / Secondary).
// All 6 participants MUST have Nitzan certification.
// Segol Main: 2× L0, 1× L3/L4.
// Segol Secondary: 2× L0, 1× L2.
// Group constraint: all 6 participants in a shift must be from the same group.

/**
 * Build slots for a single Adanit shift (both teams combined = 6 slots).
 *
 * Segol Main: 2× L0, 1× L3+ (L3/L4)
 * Segol Secondary: 2× L0, 1× L2
 *
 * All slots require Nitzan certification.
 */
function buildAdanitSlots(): SlotRequirement[] {
  const slots: SlotRequirement[] = [];
  const prefix = 'adanit';

  // Segol Main: 2× L0
  for (let i = 0; i < 2; i++) {
    slots.push({
      slotId: nextSlotId(prefix),
      acceptableLevels: [Level.L0],
      requiredCertifications: [Certification.Nitzan],
      adanitTeam: AdanitTeam.SegolMain,
      label: `Segol Main L0 #${i + 1}`,
    });
  }
  // Segol Main: 1× L3/L4
  slots.push({
    slotId: nextSlotId(prefix),
    acceptableLevels: [Level.L3, Level.L4],
    requiredCertifications: [Certification.Nitzan],
    adanitTeam: AdanitTeam.SegolMain,
    label: 'Segol Main L3/L4',
  });

  // Segol Secondary: 2× L0
  for (let i = 0; i < 2; i++) {
    slots.push({
      slotId: nextSlotId(prefix),
      acceptableLevels: [Level.L0],
      requiredCertifications: [Certification.Nitzan],
      adanitTeam: AdanitTeam.SegolSecondary,
      label: `Segol Secondary L0 #${i + 1}`,
    });
  }
  // Segol Secondary: 1× L2
  slots.push({
    slotId: nextSlotId(prefix),
    acceptableLevels: [Level.L2],
    requiredCertifications: [Certification.Nitzan],
    adanitTeam: AdanitTeam.SegolSecondary,
    label: 'Segol Secondary L2',
  });

  return slots;
}

/**
 * Create 3 Adanit shift tasks for a given base date.
 * Shifts: 05:00-13:00, 13:00-21:00, 21:00-05:00 (next day).
 */
export function createAdanitTasks(baseDate: Date): Task[] {
  const shifts = generateShiftBlocks(
    new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 5, 0),
    8,
    3,
  );

  return shifts.map((block, i) => {
    // Reset slot counter per task set for determinism? No, keep global for uniqueness.
    const slots = buildAdanitSlots();
    return {
      id: nextTaskId('adanit'),
      type: TaskType.Adanit,
      name: `Adanit Shift ${i + 1}`,
      timeBlock: block,
      requiredCount: 6,
      slots,
      isLight: false,
      sameGroupRequired: true,
      blocksConsecutive: true,
    };
  });
}

// ─── Hamama ──────────────────────────────────────────────────────────────────
// 12h, 1 participant, requires Hamama certification.
// Priority: L0 best, L3 high penalty, L4 extreme penalty.

export function createHamamaTask(timeBlock: TimeBlock): Task {
  return {
    id: nextTaskId('hamama'),
    type: TaskType.Hamama,
    name: 'Hamama',
    timeBlock,
    requiredCount: 1,
    slots: [
      {
        slotId: nextSlotId('hamama'),
        acceptableLevels: [Level.L0, Level.L2, Level.L3, Level.L4],
        requiredCertifications: [Certification.Hamama],
        label: 'Hamama Operator',
      },
    ],
    isLight: false,
    baseLoadWeight: 0.6,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

// ─── Shemesh ─────────────────────────────────────────────────────────────────
// 4h, 2 participants, requires Nitzan. Preference for same group.

export function createShemeshTask(timeBlock: TimeBlock): Task {
  return {
    id: nextTaskId('shemesh'),
    type: TaskType.Shemesh,
    name: 'Shemesh',
    timeBlock,
    requiredCount: 2,
    slots: [
      {
        slotId: nextSlotId('shemesh'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [Certification.Nitzan],
        label: 'Shemesh #1',
      },
      {
        slotId: nextSlotId('shemesh'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [Certification.Nitzan],
        label: 'Shemesh #2',
      },
    ],
    isLight: false,
    sameGroupRequired: false, // soft preference, not hard
    blocksConsecutive: true,
  };
}

// ─── Mamtera ─────────────────────────────────────────────────────────────────
// 14h, 09:00-23:00, 2× L0. No Nitzan required.

export function createMamteraTask(baseDate: Date): Task {
  const block = createTimeBlockFromHours(baseDate, 9, 23);
  return {
    id: nextTaskId('mamtera'),
    type: TaskType.Mamtera,
    name: 'Mamtera',
    timeBlock: block,
    requiredCount: 2,
    slots: [
      {
        slotId: nextSlotId('mamtera'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: 'Mamtera L0 #1',
      },
      {
        slotId: nextSlotId('mamtera'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: 'Mamtera L0 #2',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

// ─── Karov ───────────────────────────────────────────────────────────────────
// 8h, 4 participants: 1× L2/L3/L4, 3× L0 (one L0 must have Salsala).
// Load weighting: hot windows 05:00-06:30 and 17:00-18:30 at 100%,
// outside windows at 20% effective load.

export function createKarovTask(timeBlock: TimeBlock): Task {
  return {
    id: nextTaskId('karov'),
    type: TaskType.Karov,
    name: 'Karov',
    timeBlock,
    requiredCount: 4,
    slots: [
      {
        slotId: nextSlotId('karov'),
        acceptableLevels: [Level.L2, Level.L3, Level.L4],
        requiredCertifications: [],
        label: 'Karov Commander (L2/L3/L4)',
      },
      {
        slotId: nextSlotId('karov'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [Certification.Salsala],
        label: 'Karov L0 + Salsala',
      },
      {
        slotId: nextSlotId('karov'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: 'Karov L0 #2',
      },
      {
        slotId: nextSlotId('karov'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: 'Karov L0 #3',
      },
    ],
    isLight: false,
    baseLoadWeight: 0.2,
    loadWindows: [
      {
        id: 'karov-hot-am',
        startHour: 5,
        startMinute: 0,
        endHour: 6,
        endMinute: 30,
        weight: 1,
      },
      {
        id: 'karov-hot-pm',
        startHour: 17,
        startMinute: 0,
        endHour: 18,
        endMinute: 30,
        weight: 1,
      },
    ],
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
}

// ─── Karovit (Light) ─────────────────────────────────────────────────────────
// 8h, 4 people per shift. Light task — no rest impact.
// 1× L2+ (L2/L3/L4), 3× L0.

export function createKarovitTask(timeBlock: TimeBlock): Task {
  return {
    id: nextTaskId('karovit'),
    type: TaskType.Karovit,
    name: 'Karovit',
    timeBlock,
    requiredCount: 4,
    slots: [
      {
        slotId: nextSlotId('karovit'),
        acceptableLevels: [Level.L2, Level.L3, Level.L4],
        requiredCertifications: [],
        label: 'Karovit Commander (L2+)',
      },
      {
        slotId: nextSlotId('karovit'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: 'Karovit L0 #1',
      },
      {
        slotId: nextSlotId('karovit'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: 'Karovit L0 #2',
      },
      {
        slotId: nextSlotId('karovit'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: 'Karovit L0 #3',
      },
    ],
    isLight: true,
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
}

// ─── Aruga ───────────────────────────────────────────────────────────────────
// 1.5h, 2× L0. Specific morning/evening slots.

export function createArugaTask(timeBlock: TimeBlock, label: string = 'Aruga'): Task {
  return {
    id: nextTaskId('aruga'),
    type: TaskType.Aruga,
    name: label,
    timeBlock,
    requiredCount: 2,
    slots: [
      {
        slotId: nextSlotId('aruga'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: `${label} L0 #1`,
      },
      {
        slotId: nextSlotId('aruga'),
        acceptableLevels: [Level.L0],
        requiredCertifications: [],
        label: `${label} L0 #2`,
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

/**
 * Generate a full day's task set for a given base date.
 * Creates:
 *  - 3 Adanit shifts (05:00 cycle)
 *  - 2 Hamama blocks (06:00-18:00, 18:00-06:00)
 *  - 6 Shemesh blocks (4h each, 05:00 cycle)
 *  - 1 Mamtera (09:00-23:00)
 *  - 3 Karov blocks (05:00 cycle)
 *  - 3 Karovit blocks (05:00 cycle, 4 people each)
 *  - 2 Aruga (morning 05:00-06:30, evening 17:00-18:30)
 */
export function generateDailyTasks(baseDate: Date): Task[] {
  resetSlotCounter();
  resetTaskCounter();
  const tasks: Task[] = [];
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());

  // Adanit: 3× 8h shifts starting 05:00
  tasks.push(...createAdanitTasks(d));

  // Hamama: 2× 12h (06:00-18:00, 18:00-06:00+1)
  tasks.push(createHamamaTask(createTimeBlockFromHours(d, 6, 18)));
  tasks.push(createHamamaTask(createTimeBlockFromHours(d, 18, 6)));

  // Shemesh: 6× 4h covering 24h starting at 05:00
  // 05:00-09:00, 09:00-13:00, 13:00-17:00, 17:00-21:00, 21:00-01:00, 01:00-05:00
  for (let h = 5; h < 29; h += 4) {
    const startHour = h % 24;
    const block = createTimeBlockFromHours(d, startHour, 0, 4);
    // Adjust for day boundary
    if (h >= 24) {
      const nextDay = new Date(d.getTime());
      nextDay.setDate(nextDay.getDate() + 1);
      const nb = createTimeBlockFromHours(nextDay, startHour, 0, 4);
      tasks.push(createShemeshTask(nb));
    } else {
      tasks.push(createShemeshTask(block));
    }
  }

  // Mamtera: 09:00-23:00
  tasks.push(createMamteraTask(d));

  // Karov: 3× 8h shifts starting 05:00
  const karovShifts = generateShiftBlocks(
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0),
    8,
    3,
  );
  for (const block of karovShifts) {
    tasks.push(createKarovTask(block));
  }

  // Karovit: 3× 8h shifts starting 05:00
  const karovitShifts = generateShiftBlocks(
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0),
    8,
    3,
  );
  for (const block of karovitShifts) {
    tasks.push(createKarovitTask(block));
  }

  // Aruga: morning 05:00-06:30, evening 17:00-18:30
  const arugaMorningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0);
  const arugaMorningEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6, 30);
  tasks.push(createArugaTask({ start: arugaMorningStart, end: arugaMorningEnd }, 'Aruga Morning'));

  const arugaEveningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 0);
  const arugaEveningEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 30);
  tasks.push(createArugaTask({ start: arugaEveningStart, end: arugaEveningEnd }, 'Aruga Evening'));

  return tasks;
}

/**
 * Generate tasks for an entire 7-day (or N-day) window.
 * Each day's tasks are tagged with a day index for cross-day referencing.
 *
 * @param startDate - First day of the window
 * @param numDays - Number of days (default 7)
 * @returns All tasks across the multi-day window
 */
export function generateWeeklyTasks(startDate: Date, numDays: number = 7): Task[] {
  resetSlotCounter();
  resetTaskCounter();
  const allTasks: Task[] = [];

  for (let day = 0; day < numDays; day++) {
    const dayDate = new Date(
      startDate.getFullYear(),
      startDate.getMonth(),
      startDate.getDate() + day,
    );
    const dayTasks = generateDailyTasks(dayDate);

    // Prefix task names with day number for clarity
    for (const t of dayTasks) {
      t.name = `D${day + 1} ${t.name}`;
    }

    allTasks.push(...dayTasks);
  }

  return allTasks;
}
