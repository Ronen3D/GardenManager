"use strict";
/**
 * Task Library - Factory functions to create properly-typed Task instances
 * with all slot requirements and constraints.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAdanitTasks = createAdanitTasks;
exports.createHamamaTask = createHamamaTask;
exports.createShemeshTask = createShemeshTask;
exports.createMamteraTask = createMamteraTask;
exports.createKarovTask = createKarovTask;
exports.createKarovitTask = createKarovitTask;
exports.createArugaTask = createArugaTask;
exports.generateDailyTasks = generateDailyTasks;
const types_1 = require("../models/types");
const time_utils_1 = require("../utils/time-utils");
let _slotCounter = 0;
function nextSlotId(prefix) {
    return `${prefix}-slot-${++_slotCounter}`;
}
let _taskCounter = 0;
function nextTaskId(prefix) {
    return `${prefix}-${++_taskCounter}`;
}
// ─── Adanit ──────────────────────────────────────────────────────────────────
// 8h, 3 shifts per day. 2 teams (Segol Main / Secondary).
// Each team: 2× L0, 1× L1 (only in SegolMain), 1× (L3 or L4).
// Group constraint: all 8 participants in a shift must be from the same group.
/**
 * Build slots for a single Adanit shift (both teams combined = 8 slots).
 *
 * Segol Main: 2× L0, 1× L1, 1× L3/L4
 * Segol Secondary: 2× L0, 1× L3/L4  (no L1 needed here, but we need 4 slots)
 *   → adjusted: Segol Secondary has 3× L0 and 1× L3/L4
 *
 * Wait, re-reading: "2 teams" × "2× L0, 1× L1, 1× L3/L4" = 8 per shift.
 * But: "Only one Level 1 is needed per Adanit task (specifically in Segol Main)."
 * So Segol Secondary uses: 3× L0, 1× L3/L4 to fill the 4 slots.
 */
function buildAdanitSlots() {
    const slots = [];
    const prefix = 'adanit';
    // Segol Main: 2× L0
    for (let i = 0; i < 2; i++) {
        slots.push({
            slotId: nextSlotId(prefix),
            acceptableLevels: [types_1.Level.L0],
            requiredCertifications: [],
            adanitTeam: types_1.AdanitTeam.SegolMain,
            label: `Segol Main L0 #${i + 1}`,
        });
    }
    // Segol Main: 1× L1
    slots.push({
        slotId: nextSlotId(prefix),
        acceptableLevels: [types_1.Level.L1],
        requiredCertifications: [],
        adanitTeam: types_1.AdanitTeam.SegolMain,
        label: 'Segol Main L1',
    });
    // Segol Main: 1× L3/L4
    slots.push({
        slotId: nextSlotId(prefix),
        acceptableLevels: [types_1.Level.L3, types_1.Level.L4],
        requiredCertifications: [],
        adanitTeam: types_1.AdanitTeam.SegolMain,
        label: 'Segol Main L3/L4',
    });
    // Segol Secondary: 3× L0
    for (let i = 0; i < 3; i++) {
        slots.push({
            slotId: nextSlotId(prefix),
            acceptableLevels: [types_1.Level.L0],
            requiredCertifications: [],
            adanitTeam: types_1.AdanitTeam.SegolSecondary,
            label: `Segol Secondary L0 #${i + 1}`,
        });
    }
    // Segol Secondary: 1× L3/L4
    slots.push({
        slotId: nextSlotId(prefix),
        acceptableLevels: [types_1.Level.L3, types_1.Level.L4],
        requiredCertifications: [],
        adanitTeam: types_1.AdanitTeam.SegolSecondary,
        label: 'Segol Secondary L3/L4',
    });
    return slots;
}
/**
 * Create 3 Adanit shift tasks for a given base date.
 * Shifts: 06:00-14:00, 14:00-22:00, 22:00-06:00 (next day).
 */
function createAdanitTasks(baseDate) {
    const shifts = (0, time_utils_1.generateShiftBlocks)(new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 6, 0), 8, 3);
    return shifts.map((block, i) => {
        // Reset slot counter per task set for determinism? No, keep global for uniqueness.
        const slots = buildAdanitSlots();
        return {
            id: nextTaskId('adanit'),
            type: types_1.TaskType.Adanit,
            name: `Adanit Shift ${i + 1}`,
            timeBlock: block,
            requiredCount: 8,
            slots,
            isLight: false,
            sameGroupRequired: true,
        };
    });
}
// ─── Hamama ──────────────────────────────────────────────────────────────────
// 12h, 1 participant, requires Hamama certification.
// Priority: L0 best, L3 high penalty, L4 extreme penalty.
function createHamamaTask(timeBlock) {
    return {
        id: nextTaskId('hamama'),
        type: types_1.TaskType.Hamama,
        name: 'Hamama',
        timeBlock,
        requiredCount: 1,
        slots: [
            {
                slotId: nextSlotId('hamama'),
                acceptableLevels: [types_1.Level.L0, types_1.Level.L3, types_1.Level.L4],
                requiredCertifications: [types_1.Certification.Hamama],
                label: 'Hamama Operator',
            },
        ],
        isLight: false,
        sameGroupRequired: false,
    };
}
// ─── Shemesh ─────────────────────────────────────────────────────────────────
// 4h, 2 participants, requires Nitzan. Preference for same group.
function createShemeshTask(timeBlock) {
    return {
        id: nextTaskId('shemesh'),
        type: types_1.TaskType.Shemesh,
        name: 'Shemesh',
        timeBlock,
        requiredCount: 2,
        slots: [
            {
                slotId: nextSlotId('shemesh'),
                acceptableLevels: [types_1.Level.L0, types_1.Level.L1, types_1.Level.L2, types_1.Level.L3, types_1.Level.L4],
                requiredCertifications: [types_1.Certification.Nitzan],
                label: 'Shemesh #1',
            },
            {
                slotId: nextSlotId('shemesh'),
                acceptableLevels: [types_1.Level.L0, types_1.Level.L1, types_1.Level.L2, types_1.Level.L3, types_1.Level.L4],
                requiredCertifications: [types_1.Certification.Nitzan],
                label: 'Shemesh #2',
            },
        ],
        isLight: false,
        sameGroupRequired: false, // soft preference, not hard
    };
}
// ─── Mamtera ─────────────────────────────────────────────────────────────────
// 14h, 09:00-23:00, 2× L0. No Nitzan required.
function createMamteraTask(baseDate) {
    const block = (0, time_utils_1.createTimeBlockFromHours)(baseDate, 9, 23);
    return {
        id: nextTaskId('mamtera'),
        type: types_1.TaskType.Mamtera,
        name: 'Mamtera',
        timeBlock: block,
        requiredCount: 2,
        slots: [
            {
                slotId: nextSlotId('mamtera'),
                acceptableLevels: [types_1.Level.L0],
                requiredCertifications: [],
                label: 'Mamtera L0 #1',
            },
            {
                slotId: nextSlotId('mamtera'),
                acceptableLevels: [types_1.Level.L0],
                requiredCertifications: [],
                label: 'Mamtera L0 #2',
            },
        ],
        isLight: false,
        sameGroupRequired: false,
    };
}
// ─── Karov ───────────────────────────────────────────────────────────────────
// 8h, 4 participants: 1× L2/L3/L4, 3× L0 (one L0 must have Salsala).
function createKarovTask(timeBlock) {
    return {
        id: nextTaskId('karov'),
        type: types_1.TaskType.Karov,
        name: 'Karov',
        timeBlock,
        requiredCount: 4,
        slots: [
            {
                slotId: nextSlotId('karov'),
                acceptableLevels: [types_1.Level.L2, types_1.Level.L3, types_1.Level.L4],
                requiredCertifications: [],
                label: 'Karov Commander (L2/L3/L4)',
            },
            {
                slotId: nextSlotId('karov'),
                acceptableLevels: [types_1.Level.L0],
                requiredCertifications: [types_1.Certification.Salsala],
                label: 'Karov L0 + Salsala',
            },
            {
                slotId: nextSlotId('karov'),
                acceptableLevels: [types_1.Level.L0],
                requiredCertifications: [],
                label: 'Karov L0 #2',
            },
            {
                slotId: nextSlotId('karov'),
                acceptableLevels: [types_1.Level.L0],
                requiredCertifications: [],
                label: 'Karov L0 #3',
            },
        ],
        isLight: false,
        sameGroupRequired: false,
    };
}
// ─── Karovit (Light) ─────────────────────────────────────────────────────────
// 8h, light task. No rest impact. Any participant.
function createKarovitTask(timeBlock, requiredCount = 1) {
    const slots = [];
    for (let i = 0; i < requiredCount; i++) {
        slots.push({
            slotId: nextSlotId('karovit'),
            acceptableLevels: [types_1.Level.L0, types_1.Level.L1, types_1.Level.L2, types_1.Level.L3, types_1.Level.L4],
            requiredCertifications: [],
            label: `Karovit #${i + 1}`,
        });
    }
    return {
        id: nextTaskId('karovit'),
        type: types_1.TaskType.Karovit,
        name: 'Karovit',
        timeBlock,
        requiredCount,
        slots,
        isLight: true,
        sameGroupRequired: false,
    };
}
// ─── Aruga ───────────────────────────────────────────────────────────────────
// 1.5h, 2× L0. Specific morning/evening slots.
function createArugaTask(timeBlock, label = 'Aruga') {
    return {
        id: nextTaskId('aruga'),
        type: types_1.TaskType.Aruga,
        name: label,
        timeBlock,
        requiredCount: 2,
        slots: [
            {
                slotId: nextSlotId('aruga'),
                acceptableLevels: [types_1.Level.L0],
                requiredCertifications: [],
                label: `${label} L0 #1`,
            },
            {
                slotId: nextSlotId('aruga'),
                acceptableLevels: [types_1.Level.L0],
                requiredCertifications: [],
                label: `${label} L0 #2`,
            },
        ],
        isLight: false,
        sameGroupRequired: false,
    };
}
/**
 * Generate a full day's task set for a given base date.
 * Creates:
 *  - 3 Adanit shifts
 *  - 2 Hamama blocks (day/night 12h each)
 *  - 6 Shemesh blocks (4h each covering 24h)
 *  - 1 Mamtera
 *  - 3 Karov blocks (8h each)
 *  - 3 Karovit blocks (8h each)
 *  - 2 Aruga (morning 06:00-07:30, evening 18:00-19:30)
 */
function generateDailyTasks(baseDate) {
    const tasks = [];
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    // Adanit: 3× 8h shifts starting 06:00
    tasks.push(...createAdanitTasks(d));
    // Hamama: 2× 12h (06:00-18:00, 18:00-06:00+1)
    tasks.push(createHamamaTask((0, time_utils_1.createTimeBlockFromHours)(d, 6, 18)));
    tasks.push(createHamamaTask((0, time_utils_1.createTimeBlockFromHours)(d, 18, 6)));
    // Shemesh: 6× 4h covering 24h starting at 06:00
    for (let h = 6; h < 30; h += 4) {
        const startHour = h % 24;
        const block = (0, time_utils_1.createTimeBlockFromHours)(d, startHour, 0, 4);
        // Adjust for day boundary
        if (h >= 24) {
            const nextDay = new Date(d.getTime());
            nextDay.setDate(nextDay.getDate() + 1);
            const nb = (0, time_utils_1.createTimeBlockFromHours)(nextDay, startHour, 0, 4);
            tasks.push(createShemeshTask(nb));
        }
        else {
            tasks.push(createShemeshTask(block));
        }
    }
    // Mamtera: 09:00-23:00
    tasks.push(createMamteraTask(d));
    // Karov: 3× 8h shifts starting 06:00
    const karovShifts = (0, time_utils_1.generateShiftBlocks)(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6, 0), 8, 3);
    for (const block of karovShifts) {
        tasks.push(createKarovTask(block));
    }
    // Karovit: 3× 8h shifts starting 06:00
    const karovitShifts = (0, time_utils_1.generateShiftBlocks)(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6, 0), 8, 3);
    for (const block of karovitShifts) {
        tasks.push(createKarovitTask(block, 2));
    }
    // Aruga: morning 06:00-07:30, evening 18:00-19:30
    const arugaMorningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 6, 0);
    const arugaMorningEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 7, 30);
    tasks.push(createArugaTask({ start: arugaMorningStart, end: arugaMorningEnd }, 'Aruga Morning'));
    const arugaEveningStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 0);
    const arugaEveningEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 19, 30);
    tasks.push(createArugaTask({ start: arugaEveningStart, end: arugaEveningEnd }, 'Aruga Evening'));
    return tasks;
}
//# sourceMappingURL=task-definitions.js.map