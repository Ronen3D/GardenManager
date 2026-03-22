
import {
  Schedule,
  Task,
  Assignment,
  Participant,
  TaskType,
  AssignmentStatus,
  AdanitTeam,
  Level,
  SlotRequirement,
  LiveModeState
} from '../models/types';
import { TASK_COLORS, groupColor, fmt, levelBadge, groupBadge, SVG_ICONS, escHtml } from './ui-helpers';
import { isFutureTask } from '../engine/temporal';
import { addDays } from 'date-fns';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getUniqueStartTimes(tasks: Task[]): number[] {
    const times = new Set<number>();
    tasks.forEach(t => times.add(new Date(t.timeBlock.start).getTime()));
    return Array.from(times).sort((a, b) => a - b);
}

export interface AssignedSlot {
    assignment?: Assignment;
    participant?: Participant;
    slot: SlotRequirement;
}

export function getTaskAssignments(task: Task, schedule: Schedule): AssignedSlot[] {
    const taskAssignments = schedule.assignments.filter(a => a.taskId === task.id);
    const participantMap = new Map(schedule.participants.map(p => [p.id, p]));
    
    // Create a copy of slots to avoid mutating original task
    // We want to map each slot to its assignment
    return task.slots.map(slot => {
        const assign = taskAssignments.find(a => a.slotId === slot.slotId);
        return {
            slot,
            assignment: assign,
            participant: assign ? participantMap.get(assign.participantId) : undefined
        };
    });
}

// ─── Card Renderer ───────────────────────────────────────────────────────────

function renderAssignmentCard(
    slot: SlotRequirement,
    assignment: Assignment | undefined,
    participant: Participant | undefined,
    task: Task,
    liveMode: LiveModeState
): string {
    const isFuture = isFutureTask(task, liveMode.currentTimestamp);
    const isFrozen = liveMode.enabled && !isFuture;
    const isLocked = assignment?.status === AssignmentStatus.Locked || assignment?.status === AssignmentStatus.Manual;
    const isConflict = assignment?.status === AssignmentStatus.Conflict;
    
    let cardClass = "assignment-card";
    if (isConflict) cardClass += " status-conflict";
    else if (isFrozen) cardClass += " status-frozen";
    else if (isLocked) cardClass += " status-locked";
    
    // Data attributes for drag/drop and interactions
    // Note: We use data-assignment-id for existing click handlers
    const dataAttrs = assignment 
        ? `data-assignment-id="${assignment.id}" data-task-id="${task.id}"` 
        : `data-slot-id="${slot.slotId}" data-task-id="${task.id}"`;

    let content = "";
    
    if (participant) {
        // Pass assignment context via data attributes so the tooltip can render action buttons
        const hoverAttrs = assignment
            ? `data-pid="${participant.id}" data-assignment-id="${assignment.id}" data-task-id="${task.id}"${isFrozen ? ' data-frozen="1"' : ''}${isLocked ? ' data-locked="1"' : ''}`
            : `data-pid="${participant.id}"`;

        content = `
            <div class="card-header">
                <span class="participant-name participant-hover" role="button" tabindex="0" ${hoverAttrs} style="color:${groupColor(participant.group)}">
                    ${escHtml(participant.name)}
                </span>
            </div>
            <div class="card-details">
                 ${isLocked ? '<span title="נעל">🔒</span>' : ''}
                 ${isFrozen ? `<span title="מוקפא">${SVG_ICONS.snowflake}</span>` : ''}
            </div>
        `;
    } else {
        content = `<div class="empty-slot-label">${slot.label ? escHtml(slot.label) : 'ריק'}</div>`;
    }

    return `
        <div class="${cardClass}" ${dataAttrs}>
            ${content}
        </div>
    `;
}

// ─── Table Renderers ─────────────────────────────────────────────────────────

function renderHamamaTable(tasks: Task[], schedule: Schedule, liveMode: LiveModeState): string {
    if (tasks.length === 0) return '';
    const uniqueTimes = getUniqueStartTimes(tasks);
    
    let rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);
        const dayTasks = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
        
        const cellContent = dayTasks.map(task => {
            const slots = getTaskAssignments(task, schedule);
            return slots.map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode)).join('');
        }).join('');

        return `
            <tr data-time="${timeNum}">
                <td class="time-cell">${fmt(time)}</td>
                <td class="task-cell">${cellContent}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="schedule-table-wrapper hamama-wrapper">
            <h3 class="table-title">חממה</h3>
            <table class="table schedule-grid-table">
                <thead><tr><th class="col-time">זמן</th><th>חממה</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function renderArogaTable(tasks: Task[], schedule: Schedule, liveMode: LiveModeState): string {
    if (tasks.length === 0) return '';
    const uniqueTimes = getUniqueStartTimes(tasks);

    let rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);
        const dayTasks = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
        
        let slot1Html = '';
        let slot2Html = '';

        dayTasks.forEach(task => {
            const slots = getTaskAssignments(task, schedule);
            // Reverse slots to match desired visual order (#2 then #1) if defined as such
            // Assuming 2 slots. Slot index 0 -> Col #1 (Right?), Slot index 1 -> Col #2 (Left?)
            // The request says "Aroga #2", "Aroga #1". 
            // Let's assume Slot 0 is #1 and Slot 1 is #2.
            // So Col 1 (Aroga #2) gets Slot 1. Col 2 (Aroga #1) gets Slot 0.
            
            slots.forEach((s, idx) => {
                const card = renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode);
                if (idx === 1) slot2Html += card; // Slot #2
                else slot1Html += card; // Slot #1
            });
        });

        return `
            <tr data-time="${timeNum}">
                <td class="time-cell">${fmt(time)}</td>
                <td class="task-cell">${slot2Html}</td>
                <td class="task-cell">${slot1Html}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="schedule-table-wrapper aroga-wrapper">
            <h3 class="table-title">ערוגה</h3>
            <table class="table schedule-grid-table">
                <thead><tr><th class="col-time">זמן</th><th>ערוגה #2</th><th>ערוגה #1</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function renderPatrolTable(
    allPatrolTasks: Task[],
    schedule: Schedule, 
    liveMode: LiveModeState
): string {
    const karovitTasks = allPatrolTasks.filter(t => t.type === TaskType.Karovit);
    const karovTasks = allPatrolTasks.filter(t => t.type === TaskType.Karov);
    const adanitTasks = allPatrolTasks.filter(t => t.type === TaskType.Adanit);
    
    if (allPatrolTasks.length === 0) return '';
    const uniqueTimes = getUniqueStartTimes(allPatrolTasks);

    let rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);

        // Helper to render tasks of a certain type at this time
        const renderType = (typeTasks: Task[]) => {
            const current = typeTasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
            return current.map(t => 
                getTaskAssignments(t, schedule).map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, t, liveMode)).join('')
            ).join('');
        };

        const karovitHtml = renderType(karovitTasks);
        const karovHtml = renderType(karovTasks);

        // Adanit logic: Split by team
        const currentAdanit = adanitTasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
        let sagolSecHtml = '';
        let sagolMainHtml = '';

        currentAdanit.forEach(task => {
            const slots = getTaskAssignments(task, schedule);
            
            const secSlots = slots.filter(s => s.slot.adanitTeam === AdanitTeam.SegolSecondary);
            sagolSecHtml += secSlots.map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode)).join('');
            
            const mainSlots = slots.filter(s => s.slot.adanitTeam === AdanitTeam.SegolMain);
            sagolMainHtml += mainSlots.map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode)).join('');
        });

        // Hide row if empty? Or show partial? 
        // Showing all rows where ANY of these exist ensures alignment if they share times.
        if (!karovitHtml && !karovHtml && !sagolSecHtml && !sagolMainHtml) return '';

        return `
            <tr data-time="${timeNum}">
                <td class="time-cell">${fmt(time)}</td>
                <td class="task-cell">${sagolMainHtml}</td>
                <td class="task-cell">${sagolSecHtml}</td>
                <td class="task-cell">${karovHtml}</td>
                <td class="task-cell">${karovitHtml}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="schedule-table-wrapper patrol-wrapper">
            <h3 class="table-title">כרוב, כרובית ואדנית</h3>
            <table class="table schedule-grid-table">
                <thead>
                    <tr>
                        <th class="col-time">זמן</th>
                        <th>סגול ראשי</th>
                        <th>סגול משני</th>
                        <th>כרוב</th>
                        <th>כרובית</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function renderMamteraTable(tasks: Task[], schedule: Schedule, liveMode: LiveModeState): string {
    if (tasks.length === 0) return '';
    const uniqueTimes = getUniqueStartTimes(tasks);
    
    let rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);
        const dayTasks = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
        
        const cellContent = dayTasks.map(task => {
            const slots = getTaskAssignments(task, schedule);
            return slots.map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode)).join('');
        }).join('');

        return `
            <tr data-time="${timeNum}">
                <td class="time-cell">${fmt(time)}</td>
                <td class="task-cell">${cellContent}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="schedule-table-wrapper mamtera-wrapper">
            <h3 class="table-title">ממטרה</h3>
            <table class="table schedule-grid-table">
                <thead><tr><th class="col-time">זמן</th><th>ממטרה</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

function renderShemeshTable(tasks: Task[], schedule: Schedule, liveMode: LiveModeState): string {
    if (tasks.length === 0) return '';
    const uniqueTimes = getUniqueStartTimes(tasks);

    let rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);
        const dayTasks = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
        
        let slot1Html = '';
        let slot2Html = '';

        dayTasks.forEach(task => {
            const slots = getTaskAssignments(task, schedule);
            // Splitting slots: Slot 0 -> #1, Slot 1 -> #2.
            // Request wants columns: "Shemesh 2#", "Shemesh #1"
            // So we put Slot 1 in Col 1, Slot 0 in Col 2.
            
            slots.forEach((s, idx) => {
                const card = renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode);
                if (idx === 1) slot2Html += card; // Slot #2
                else slot1Html += card; // Slot #1
            });
            
             // Handle if >2 slots by just appending to last col or first? 
             // Shemesh is usually 2.
        });

        return `
            <tr data-time="${timeNum}">
                <td class="time-cell">${fmt(time)}</td>
                <td class="task-cell">${slot2Html}</td>
                <td class="task-cell">${slot1Html}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="schedule-table-wrapper shemesh-wrapper">
            <h3 class="table-title">שמש</h3>
            <table class="table schedule-grid-table">
                <thead><tr><th class="col-time">זמן</th><th>שמש #2</th><th>שמש #1</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

// ─── Main View Export ────────────────────────────────────────────────────────

export function renderScheduleGrid(schedule: Schedule, currentDay: number, liveMode: LiveModeState): string {
    if (schedule.tasks.length === 0) return '<div class="alert alert-info">אין משימות בשבצ"ק.</div>';

    // 1. Calculate Day Range
    // Find the earliest start time to anchor the schedule days
    const allStarts = schedule.tasks.map(t => new Date(t.timeBlock.start).getTime());
    const minStart = Math.min(...allStarts);
    const scheduleStart = new Date(minStart);
    
    // Normalize logic: If schedule starts late in the day (e.g. 18:00), checking 05:00 might be tricky.
    // The existing app tracks "Day 1, Day 2", so we rely on `addDays(scheduleStart, currentDay - 1)` essentially.
    // However, to be precise with the previous day logic:
    // Let's rely on the fact that existing logic in app.ts uses `getDayWindow(currentDay)`.
    // But we need to act standalone.
    
    // "Logical Day" calculation:
    const dayAnchor = addDays(scheduleStart, currentDay - 1);
    
    // Define the window: Day 05:00 -> Next Day 05:00
    // Reset to 05:00 of that date
    // Note: if minStart is < 05:00, then "Day 1" might be "yesterday 05:00"? 
    // Usually schedules start Day 1 @ 05:00.
    
    const dayStart = new Date(dayAnchor);
    if (dayStart.getHours() < 5) {
        // If the anchor is e.g. 02:00, the "Day" actually started previous calendar day 05:00
        dayStart.setDate(dayStart.getDate() - 1);
    }
    dayStart.setHours(5, 0, 0, 0); 
    const dayEnd = addDays(dayStart, 1);
    
    const startTimeNum = dayStart.getTime();
    const endTimeNum = dayEnd.getTime();

    const dayTasks = schedule.tasks.filter(t => {
        const s = new Date(t.timeBlock.start).getTime();
        return s >= startTimeNum && s < endTimeNum;
    });

    // 2. Filter by Type
    const hamama = dayTasks.filter(t => t.type === TaskType.Hamama);
    const aruga = dayTasks.filter(t => t.type === TaskType.Aruga);
    const patrol = dayTasks.filter(t => 
        t.type === TaskType.Karov || t.type === TaskType.Karovit || t.type === TaskType.Adanit
    );
    const mamtera = dayTasks.filter(t => t.type === TaskType.Mamtera);
    const shemesh = dayTasks.filter(t => t.type === TaskType.Shemesh);

    // 3. Render Grid Layout
    // CSS Grid layout:
    //  [ Patrol (wide) ]  [ Hamama  ]
    //                     [ Aruga   ]
    //                     [ Mamtera ]
    //  [        Shemesh (full width)        ]
    
    return `
        <div class="schedule-grid-container">
            <div class="area-patrol">${renderPatrolTable(patrol, schedule, liveMode)}</div>
            <div class="area-hamama">${renderHamamaTable(hamama, schedule, liveMode)}</div>
            <div class="area-aruga">${renderArogaTable(aruga, schedule, liveMode)}</div>
            <div class="area-mamtera">${renderMamteraTable(mamtera, schedule, liveMode)}</div>
            <div class="area-shemesh">${renderShemeshTable(shemesh, schedule, liveMode)}</div>
        </div>
    `;
}
