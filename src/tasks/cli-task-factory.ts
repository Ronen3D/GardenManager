/**
 * CLI Task Factory — Shared task-creation utilities for Node CLI scripts
 * (demo, priority simulation, priority evaluation, priority map analysis).
 *
 * These factories produce Task instances matching the canonical garden
 * schedule shape used for benchmarking and demonstration. They are NOT
 * used by the web app, which builds tasks from data-driven TaskTemplates.
 */

import {
  Task,
  SlotRequirement,
  Level,
  Certification,
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

function buildAdanitSlots(): SlotRequirement[] {
  const slots: SlotRequirement[] = [];
  const prefix = 'adanit';

  // Segol Main: 2× L0
  for (let i = 0; i < 2; i++) {
    slots.push({
      slotId: nextSlotId(prefix),
      acceptableLevels: [{ level: Level.L0 }],
      requiredCertifications: [Certification.Nitzan],
      subTeamId: 'segol-main',
      label: 'משתתף בסגול א',
    });
  }
  // Segol Main: 1× L3/L4
  slots.push({
    slotId: nextSlotId(prefix),
    acceptableLevels: [{ level: Level.L3 }, { level: Level.L4 }],
    requiredCertifications: [Certification.Nitzan],
    subTeamId: 'segol-main',
    label: 'סגל בסגול א',
  });

  // Segol Secondary: 2× L0
  for (let i = 0; i < 2; i++) {
    slots.push({
      slotId: nextSlotId(prefix),
      acceptableLevels: [{ level: Level.L0 }],
      requiredCertifications: [Certification.Nitzan],
      subTeamId: 'segol-secondary',
      label: 'משתתף בסגול ב',
    });
  }
  // Segol Secondary: 1× L2
  slots.push({
    slotId: nextSlotId(prefix),
    acceptableLevels: [{ level: Level.L2 }],
    requiredCertifications: [Certification.Nitzan],
    subTeamId: 'segol-secondary',
    label: 'בכיר בסגול ב\'',
  });

  return slots;
}

export function createAdanitTasks(baseDate: Date): Task[] {
  const shifts = generateShiftBlocks(
    new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 5, 0),
    8,
    3,
  );

  return shifts.map((block, i) => {
    const slots = buildAdanitSlots();
    return {
      id: nextTaskId('adanit'),
      name: `משמרת אדנית ${i + 1}`,
      sourceName: 'אדנית',
      timeBlock: block,
      requiredCount: 6,
      slots,
      isLight: false,
      sameGroupRequired: true,
      blocksConsecutive: true,
      requiresCategoryBreak: true,
    };
  });
}

// ─── Hamama ──────────────────────────────────────────────────────────────────

export function createHamamaTask(timeBlock: TimeBlock): Task {
  return {
    id: nextTaskId('hamama'),
    name: 'חממה',
    sourceName: 'חממה',
    timeBlock,
    requiredCount: 1,
    slots: [
      {
        slotId: nextSlotId('hamama'),
        acceptableLevels: [{ level: Level.L0 }, { level: Level.L4, lowPriority: true }],
        requiredCertifications: [Certification.Hamama],
        label: 'מפעיל חממה',
      },
    ],
    isLight: false,
    baseLoadWeight: 5 / 6,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

// ─── Shemesh ─────────────────────────────────────────────────────────────────

export function createShemeshTask(timeBlock: TimeBlock): Task {
  return {
    id: nextTaskId('shemesh'),
    name: 'שמש',
    sourceName: 'שמש',
    timeBlock,
    requiredCount: 2,
    slots: [
      {
        slotId: nextSlotId('shemesh'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בשמש',
      },
      {
        slotId: nextSlotId('shemesh'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בשמש',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
    requiresCategoryBreak: true,
  };
}

// ─── Mamtera ─────────────────────────────────────────────────────────────────

export function createMamteraTask(baseDate: Date): Task {
  const block = createTimeBlockFromHours(baseDate, 9, 23);
  return {
    id: nextTaskId('mamtera'),
    name: 'ממטרה',
    sourceName: 'ממטרה',
    timeBlock: block,
    requiredCount: 2,
    slots: [
      {
        slotId: nextSlotId('mamtera'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
        forbiddenCertifications: [Certification.Horesh],
        label: 'משתתף בממטרה',
      },
      {
        slotId: nextSlotId('mamtera'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [],
        forbiddenCertifications: [Certification.Horesh],
        label: 'משתתף בממטרה',
      },
    ],
    isLight: false,
    baseLoadWeight: 4 / 9,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

// ─── Karov ───────────────────────────────────────────────────────────────────

export function createKarovTask(timeBlock: TimeBlock): Task {
  return {
    id: nextTaskId('karov'),
    name: 'כרוב',
    sourceName: 'כרוב',
    timeBlock,
    requiredCount: 4,
    slots: [
      {
        slotId: nextSlotId('karov'),
        acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'מפקד כרוב',
      },
      {
        slotId: nextSlotId('karov'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Salsala, Certification.Nitzan],
        label: 'נהג כרוב',
      },
      {
        slotId: nextSlotId('karov'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בכרוב',
      },
      {
        slotId: nextSlotId('karov'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בקרוב',
      },
    ],
    isLight: false,
    baseLoadWeight: 1 / 3,
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

export function createKarovitTask(timeBlock: TimeBlock): Task {
  return {
    id: nextTaskId('karovit'),
    name: 'כרובית',
    sourceName: 'כרובית',
    timeBlock,
    requiredCount: 4,
    slots: [
      {
        slotId: nextSlotId('karovit'),
        acceptableLevels: [{ level: Level.L2 }, { level: Level.L3 }, { level: Level.L4 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'סגל כרובית',
      },
      {
        slotId: nextSlotId('karovit'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בכרובית',
      },
      {
        slotId: nextSlotId('karovit'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בכרובית',
      },
      {
        slotId: nextSlotId('karovit'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בכרובית',
      },
    ],
    isLight: true,
    sameGroupRequired: false,
    blocksConsecutive: false,
  };
}

// ─── Aruga ───────────────────────────────────────────────────────────────────

export function createArugaTask(timeBlock: TimeBlock, label: string = 'ערוגה', sourceName?: string): Task {
  return {
    id: nextTaskId('aruga'),
    name: label,
    sourceName: sourceName ?? label,
    timeBlock,
    requiredCount: 2,
    slots: [
      {
        slotId: nextSlotId('aruga'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בערוגה',
      },
      {
        slotId: nextSlotId('aruga'),
        acceptableLevels: [{ level: Level.L0 }],
        requiredCertifications: [Certification.Nitzan],
        label: 'משתתף בערוגה',
      },
    ],
    isLight: false,
    sameGroupRequired: false,
    blocksConsecutive: true,
  };
}

// ─── Daily / Weekly Generators ───────────────────────────────────────────────

export function generateDailyTasks(baseDate: Date, resetCounters: boolean = true): Task[] {
  if (resetCounters) {
    resetSlotCounter();
    resetTaskCounter();
  }
  const tasks: Task[] = [];
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());

  // Adanit: 3× 8h shifts starting 05:00
  tasks.push(...createAdanitTasks(d));

  // Hamama: 2× 12h (06:00-18:00, 18:00-06:00+1)
  tasks.push(createHamamaTask(createTimeBlockFromHours(d, 6, 18)));
  tasks.push(createHamamaTask(createTimeBlockFromHours(d, 18, 6)));

  // Shemesh: 6× 4h covering 24h starting at 05:00
  for (let h = 5; h < 29; h += 4) {
    const startHour = h % 24;
    const block = createTimeBlockFromHours(d, startHour, 0, 4);
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

  // ערוגת בוקר: 05:00-06:30
  const arugaMorningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0);
  const arugaMorningEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6, 30);
  tasks.push(createArugaTask({ start: arugaMorningStart, end: arugaMorningEnd }, 'ערוגת בוקר', 'ערוגת בוקר'));

  // ערוגת ערב: 17:00-18:30
  const arugaEveningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 0);
  const arugaEveningEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 30);
  tasks.push(createArugaTask({ start: arugaEveningStart, end: arugaEveningEnd }, 'ערוגת ערב', 'ערוגת ערב'));

  return tasks;
}

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
    const dayTasks = generateDailyTasks(dayDate, false);

    for (const t of dayTasks) {
      t.name = `יום ${day + 1} ${t.name}`;
    }

    allTasks.push(...dayTasks);
  }

  return allTasks;
}
