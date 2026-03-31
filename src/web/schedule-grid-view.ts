
import {
  Schedule,
  Task,
  Assignment,
  Participant,
  AssignmentStatus,
  AdanitTeam,
  Level,
  SlotRequirement,
  LiveModeState
} from '../models/types';
import { TASK_COLORS, TASK_TYPE_LABELS, groupColor, fmt, levelBadge, groupBadge, SVG_ICONS, escHtml } from './ui-helpers';
import { isFutureTask } from '../engine/temporal';
import { addDays } from 'date-fns';

/** Resolve a task's display category, with fallback for un-migrated data. */
function getDisplayCategory(task: Task): string {
  if (task.displayCategory) return task.displayCategory;
  return (task.type || 'custom').toLowerCase();
}

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

/** Count how many columns the patrol table would render (for grid sizing). */
function countPatrolColumns(patrolTasks: Task[]): number {
    let count = 0;
    // Adanit-team columns (slots with adanitTeam designation)
    if (patrolTasks.some(t => t.slots.some(s => s.adanitTeam === AdanitTeam.SegolMain))) count++;
    if (patrolTasks.some(t => t.slots.some(s => s.adanitTeam === AdanitTeam.SegolSecondary))) count++;
    // One column per unique task type that has NO adanitTeam slots
    const nonTeamTypes = new Set<string>();
    for (const t of patrolTasks) {
        if (!t.slots.some(s => s.adanitTeam != null)) {
            nonTeamTypes.add(t.type as string);
        }
    }
    count += nonTeamTypes.size;
    return count;
}

function renderTimeCell(time: Date, timeNum: number): string {
    return `<td class="time-cell time-cell-inspectable" data-time-ms="${timeNum}" role="button" tabindex="0" title="הצג זמינות לפי פק\"ל">${fmt(time)}</td>`;
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
                ${renderTimeCell(time, timeNum)}
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

    // Discover sub-teams dynamically from slots
    const subTeamIds = new Set<string>();
    for (const t of tasks) {
        for (const s of t.slots) {
            subTeamIds.add(s.subTeamId ?? '');
        }
    }
    const subTeams = Array.from(subTeamIds);

    const uniqueTimes = getUniqueStartTimes(tasks);

    const rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);
        const dayTasks = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);

        const colHtml: string[] = subTeams.map(() => '');

        dayTasks.forEach(task => {
            const slots = getTaskAssignments(task, schedule);
            slots.forEach(s => {
                const card = renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode);
                const idx = subTeams.indexOf(s.slot.subTeamId ?? '');
                if (idx >= 0) colHtml[idx] += card;
            });
        });

        return `
            <tr data-time="${timeNum}">
                ${renderTimeCell(time, timeNum)}
                ${colHtml.map(h => `<td class="task-cell">${h}</td>`).join('')}
            </tr>
        `;
    }).join('');

    // Build headers: use slot labels grouped by sub-team, fallback to "ערוגה #N"
    const headers = subTeams.map((stId, i) => {
        // Try to find a human-readable name from the first task's slots
        const sample = tasks[0]?.slots.find(s => (s.subTeamId ?? '') === stId);
        if (sample?.label) return sample.label;
        return subTeams.length === 1 ? 'ערוגה' : `ערוגה #${subTeams.length - i}`;
    });

    return `
        <div class="schedule-table-wrapper aroga-wrapper">
            <h3 class="table-title">ערוגה</h3>
            <table class="table schedule-grid-table">
                <thead><tr><th class="col-time">זמן</th>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
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
    if (allPatrolTasks.length === 0) return '';

    // Split tasks: those with adanitTeam slots vs. regular (per-type) columns
    const teamTasks = allPatrolTasks.filter(t => t.slots.some(s => s.adanitTeam != null));
    const nonTeamTasks = allPatrolTasks.filter(t => !t.slots.some(s => s.adanitTeam != null));

    // Detect which adanit teams exist
    const hasMain = teamTasks.some(t => t.slots.some(s => s.adanitTeam === AdanitTeam.SegolMain));
    const hasSec  = teamTasks.some(t => t.slots.some(s => s.adanitTeam === AdanitTeam.SegolSecondary));

    // Group non-team tasks by type → one column per type
    const nonTeamTypes: string[] = [];
    const nonTeamByType = new Map<string, Task[]>();
    for (const t of nonTeamTasks) {
        const key = t.type as string;
        if (!nonTeamByType.has(key)) {
            nonTeamTypes.push(key);
            nonTeamByType.set(key, []);
        }
        nonTeamByType.get(key)!.push(t);
    }

    // Build dynamic column definitions
    type Col = { key: string; label: string };
    const cols: Col[] = [];
    if (hasMain) cols.push({ key: 'main', label: 'סגול ראשי' });
    if (hasSec)  cols.push({ key: 'sec',  label: 'סגול משני' });
    for (const typeKey of nonTeamTypes) {
        cols.push({ key: `type_${typeKey}`, label: (TASK_TYPE_LABELS as Record<string, string>)[typeKey] || typeKey });
    }

    if (cols.length === 0) return '';

    const uniqueTimes = getUniqueStartTimes(allPatrolTasks);

    const rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);
        const cells: Record<string, string> = {};
        for (const c of cols) cells[c.key] = '';

        // Render non-team type columns
        for (const typeKey of nonTeamTypes) {
            const typeTasks = nonTeamByType.get(typeKey) || [];
            const current = typeTasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
            cells[`type_${typeKey}`] = current.map(t =>
                getTaskAssignments(t, schedule).map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, t, liveMode)).join('')
            ).join('');
        }

        // Render adanit-team columns (split by team)
        const currentTeam = teamTasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
        currentTeam.forEach(task => {
            const slots = getTaskAssignments(task, schedule);
            if (hasSec) {
                cells.sec += slots.filter(s => s.slot.adanitTeam === AdanitTeam.SegolSecondary)
                    .map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode)).join('');
            }
            if (hasMain) {
                cells.main += slots.filter(s => s.slot.adanitTeam === AdanitTeam.SegolMain)
                    .map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode)).join('');
            }
        });

        if (cols.every(c => !cells[c.key])) return '';

        return `
            <tr data-time="${timeNum}">
                ${renderTimeCell(time, timeNum)}
                ${cols.map(c => `<td class="task-cell">${cells[c.key]}</td>`).join('')}
            </tr>
        `;
    }).join('');

    // Build dynamic title from present task types
    const titleParts: string[] = [];
    if (nonTeamTypes.length > 0) {
        titleParts.push(nonTeamTypes.map(t => (TASK_TYPE_LABELS as Record<string, string>)[t] || t).join(', '));
    }
    if (hasMain || hasSec) {
        // Find the name from team tasks (e.g. "אדנית")
        const teamTypeNames = [...new Set(teamTasks.map(t => (TASK_TYPE_LABELS as Record<string, string>)[t.type as string] || t.type))];
        titleParts.push(teamTypeNames.join(', '));
    }
    const title = titleParts.join(' ו');

    return `
        <div class="schedule-table-wrapper patrol-wrapper">
            <h3 class="table-title">${title}</h3>
            <table class="table schedule-grid-table">
                <thead>
                    <tr>
                        <th class="col-time">זמן</th>
                        ${cols.map(c => `<th>${c.label}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `;
}

/** Generic table renderer for custom (non-built-in) display categories. */
function renderGenericTable(tasks: Task[], schedule: Schedule, liveMode: LiveModeState): string {
    if (tasks.length === 0) return '';

    // Group by display category for title
    const categories = [...new Set(tasks.map(t => getDisplayCategory(t)))];
    const title = categories.map(c => (TASK_TYPE_LABELS as Record<string, string>)[c] || c).join(', ');
    const uniqueTimes = getUniqueStartTimes(tasks);

    const rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);
        const current = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
        const cellContent = current.map(task => {
            const slots = getTaskAssignments(task, schedule);
            return slots.map(s => renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode)).join('');
        }).join('');

        return `
            <tr data-time="${timeNum}">
                ${renderTimeCell(time, timeNum)}
                <td class="task-cell">${cellContent}</td>
            </tr>
        `;
    }).join('');

    return `
        <div class="schedule-table-wrapper">
            <h3 class="table-title">${title}</h3>
            <table class="table schedule-grid-table">
                <thead><tr><th class="col-time">זמן</th><th>${title}</th></tr></thead>
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
                ${renderTimeCell(time, timeNum)}
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

    // Discover sub-teams dynamically from slots
    const subTeamIds = new Set<string>();
    for (const t of tasks) {
        for (const s of t.slots) {
            subTeamIds.add(s.subTeamId ?? '');
        }
    }
    const subTeams = Array.from(subTeamIds);

    const uniqueTimes = getUniqueStartTimes(tasks);

    const rows = uniqueTimes.map(timeNum => {
        const time = new Date(timeNum);
        const dayTasks = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);

        const colHtml: string[] = subTeams.map(() => '');

        dayTasks.forEach(task => {
            const slots = getTaskAssignments(task, schedule);
            slots.forEach(s => {
                const card = renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode);
                const idx = subTeams.indexOf(s.slot.subTeamId ?? '');
                if (idx >= 0) colHtml[idx] += card;
            });
        });

        return `
            <tr data-time="${timeNum}">
                ${renderTimeCell(time, timeNum)}
                ${colHtml.map(h => `<td class="task-cell">${h}</td>`).join('')}
            </tr>
        `;
    }).join('');

    const headers = subTeams.map((stId, i) => {
        const sample = tasks[0]?.slots.find(s => (s.subTeamId ?? '') === stId);
        if (sample?.label) return sample.label;
        return subTeams.length === 1 ? 'שמש' : `שמש #${subTeams.length - i}`;
    });

    return `
        <div class="schedule-table-wrapper shemesh-wrapper">
            <h3 class="table-title">שמש</h3>
            <table class="table schedule-grid-table">
                <thead><tr><th class="col-time">זמן</th>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
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

    // 2. Filter by display category
    const knownCategories = new Set(['patrol', 'hamama', 'aruga', 'mamtera', 'shemesh']);
    const hamama = dayTasks.filter(t => getDisplayCategory(t) === 'hamama');
    const aruga = dayTasks.filter(t => getDisplayCategory(t) === 'aruga');
    const patrol = dayTasks.filter(t => getDisplayCategory(t) === 'patrol');
    const mamtera = dayTasks.filter(t => getDisplayCategory(t) === 'mamtera');
    const shemesh = dayTasks.filter(t => getDisplayCategory(t) === 'shemesh');
    const custom = dayTasks.filter(t => !knownCategories.has(getDisplayCategory(t)));

    // 3. Determine patrol column count for responsive grid sizing
    const patrolColCount = countPatrolColumns(patrol);
    const hasPatrol = patrol.length > 0;
    const hasRight = hamama.length > 0 || aruga.length > 0 || mamtera.length > 0;
    // Patrol gets wide column only when it has 3+ columns AND there's content beside it
    const gridClass = !hasPatrol ? 'grid-no-patrol'
        : patrolColCount <= 2 && hasRight ? 'grid-patrol-narrow'
        : 'grid-patrol-wide';

    const customHtml = custom.length > 0
        ? `<div class="area-custom">${renderGenericTable(custom, schedule, liveMode)}</div>`
        : '';

    return `
        <div class="schedule-grid-container ${gridClass}">
            <div class="area-patrol">${renderPatrolTable(patrol, schedule, liveMode)}</div>
            <div class="area-hamama">${renderHamamaTable(hamama, schedule, liveMode)}</div>
            <div class="area-aruga">${renderArogaTable(aruga, schedule, liveMode)}</div>
            <div class="area-mamtera">${renderMamteraTable(mamtera, schedule, liveMode)}</div>
            <div class="area-shemesh">${renderShemeshTable(shemesh, schedule, liveMode)}</div>
            ${customHtml}
        </div>
    `;
}
