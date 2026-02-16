"use strict";
/**
 * Browser Entry Point — Runs the scheduling engine in the browser
 * and renders results into HTML tables.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("../index");
const gantt_bridge_1 = require("../ui/gantt-bridge");
const rest_calculator_1 = require("../utils/rest-calculator");
// ─── Globals ─────────────────────────────────────────────────────────────────
let engine;
let currentSchedule = null;
// ─── Sample Data ─────────────────────────────────────────────────────────────
const BASE_DATE = new Date(2026, 1, 15);
const DAY_START = new Date(2026, 1, 15, 0, 0);
const DAY_END = new Date(2026, 1, 16, 12, 0);
function createP(id, name, level, certs, group) {
    return {
        id, name, level, certifications: certs, group,
        availability: [{ start: DAY_START, end: DAY_END }],
    };
}
const groupAlpha = [
    createP('a1', 'Alpha-01', index_1.Level.L0, [index_1.Certification.Nitzan], 'Alpha'),
    createP('a2', 'Alpha-02', index_1.Level.L0, [index_1.Certification.Salsala], 'Alpha'),
    createP('a3', 'Alpha-03', index_1.Level.L0, [index_1.Certification.Nitzan, index_1.Certification.Hamama], 'Alpha'),
    createP('a4', 'Alpha-04', index_1.Level.L0, [], 'Alpha'),
    createP('a5', 'Alpha-05', index_1.Level.L0, [], 'Alpha'),
    createP('a6', 'Alpha-06', index_1.Level.L1, [index_1.Certification.Nitzan], 'Alpha'),
    createP('a7', 'Alpha-07', index_1.Level.L3, [index_1.Certification.Nitzan, index_1.Certification.Hamama], 'Alpha'),
    createP('a8', 'Alpha-08', index_1.Level.L4, [index_1.Certification.Hamama], 'Alpha'),
];
const groupBeta = [
    createP('b1', 'Beta-01', index_1.Level.L0, [index_1.Certification.Nitzan], 'Beta'),
    createP('b2', 'Beta-02', index_1.Level.L0, [index_1.Certification.Salsala, index_1.Certification.Nitzan], 'Beta'),
    createP('b3', 'Beta-03', index_1.Level.L0, [index_1.Certification.Hamama], 'Beta'),
    createP('b4', 'Beta-04', index_1.Level.L0, [], 'Beta'),
    createP('b5', 'Beta-05', index_1.Level.L0, [], 'Beta'),
    createP('b6', 'Beta-06', index_1.Level.L1, [], 'Beta'),
    createP('b7', 'Beta-07', index_1.Level.L3, [index_1.Certification.Hamama], 'Beta'),
    createP('b8', 'Beta-08', index_1.Level.L4, [], 'Beta'),
];
const groupGamma = [
    createP('g1', 'Gamma-01', index_1.Level.L0, [index_1.Certification.Nitzan, index_1.Certification.Salsala], 'Gamma'),
    createP('g2', 'Gamma-02', index_1.Level.L0, [index_1.Certification.Hamama], 'Gamma'),
    createP('g3', 'Gamma-03', index_1.Level.L2, [index_1.Certification.Nitzan], 'Gamma'),
    createP('g4', 'Gamma-04', index_1.Level.L0, [], 'Gamma'),
    createP('g5', 'Gamma-05', index_1.Level.L0, [], 'Gamma'),
    createP('g6', 'Gamma-06', index_1.Level.L1, [index_1.Certification.Nitzan], 'Gamma'),
    createP('g7', 'Gamma-07', index_1.Level.L3, [index_1.Certification.Nitzan], 'Gamma'),
    createP('g8', 'Gamma-08', index_1.Level.L4, [index_1.Certification.Hamama], 'Gamma'),
];
const allParticipants = [...groupAlpha, ...groupBeta, ...groupGamma];
// ─── Color Map ───────────────────────────────────────────────────────────────
const TASK_COLORS = {
    Adanit: '#4A90D9',
    Hamama: '#E74C3C',
    Shemesh: '#F39C12',
    Mamtera: '#27AE60',
    Karov: '#8E44AD',
    Karovit: '#BDC3C7',
    Aruga: '#1ABC9C',
};
const GROUP_COLORS = {
    Alpha: '#3498db',
    Beta: '#e67e22',
    Gamma: '#2ecc71',
};
// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmt(d) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(d) {
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + fmt(d);
}
function levelBadge(level) {
    const colors = ['#95a5a6', '#3498db', '#2ecc71', '#e67e22', '#e74c3c'];
    return `<span class="badge" style="background:${colors[level]}">L${level}</span>`;
}
function certBadges(certs) {
    if (certs.length === 0)
        return '<span class="text-muted">—</span>';
    return certs.map(c => {
        const colors = { Nitzan: '#16a085', Salsala: '#8e44ad', Hamama: '#c0392b' };
        return `<span class="badge" style="background:${colors[c] || '#7f8c8d'}">${c}</span>`;
    }).join(' ');
}
function groupBadge(group) {
    const color = GROUP_COLORS[group] || '#7f8c8d';
    return `<span class="badge" style="background:${color}">${group}</span>`;
}
function statusBadge(status) {
    const colors = {
        Scheduled: '#27ae60', Locked: '#2980b9', Manual: '#f39c12', Conflict: '#e74c3c'
    };
    return `<span class="badge badge-sm" style="background:${colors[status] || '#7f8c8d'}">${status}</span>`;
}
function taskTypeBadge(type) {
    const color = TASK_COLORS[type] || '#7f8c8d';
    return `<span class="badge" style="background:${color}">${type}</span>`;
}
// ─── Rendering Functions ─────────────────────────────────────────────────────
function renderParticipantsTable() {
    const participants = engine.getAllParticipants();
    const groupedByGroup = new Map();
    for (const p of participants) {
        const arr = groupedByGroup.get(p.group) || [];
        arr.push(p);
        groupedByGroup.set(p.group, arr);
    }
    let html = `<div class="table-responsive"><table class="table">
    <thead><tr>
      <th>#</th><th>Name</th><th>Level</th><th>Certifications</th><th>Group</th>
    </tr></thead><tbody>`;
    let idx = 1;
    for (const [group, members] of groupedByGroup) {
        for (const p of members) {
            html += `<tr>
        <td>${idx++}</td>
        <td><strong>${p.name}</strong></td>
        <td>${levelBadge(p.level)}</td>
        <td>${certBadges(p.certifications)}</td>
        <td>${groupBadge(p.group)}</td>
      </tr>`;
        }
    }
    html += '</tbody></table></div>';
    return html;
}
function renderTasksTable() {
    const tasks = engine.getAllTasks();
    let html = `<div class="table-responsive"><table class="table">
    <thead><tr>
      <th>#</th><th>Task</th><th>Type</th><th>Time</th><th>Duration</th>
      <th>Slots</th><th>Constraints</th>
    </tr></thead><tbody>`;
    tasks.forEach((t, i) => {
        const durMs = t.timeBlock.end.getTime() - t.timeBlock.start.getTime();
        const durH = (durMs / 3600000).toFixed(1);
        const constraints = [];
        if (t.sameGroupRequired)
            constraints.push('Same Group');
        if (t.isLight)
            constraints.push('Light');
        html += `<tr>
      <td>${i + 1}</td>
      <td><strong>${t.name}</strong></td>
      <td>${taskTypeBadge(t.type)}</td>
      <td>${fmtDate(t.timeBlock.start)} → ${fmtDate(t.timeBlock.end)}</td>
      <td>${durH}h</td>
      <td>${t.requiredCount} (${t.slots.length} slots)</td>
      <td>${constraints.length ? constraints.map(c => `<span class="badge badge-outline">${c}</span>`).join(' ') : '—'}</td>
    </tr>`;
    });
    html += '</tbody></table></div>';
    return html;
}
function renderAssignmentsTable(schedule) {
    const taskMap = new Map();
    for (const t of schedule.tasks)
        taskMap.set(t.id, t);
    const pMap = new Map();
    for (const p of schedule.participants)
        pMap.set(p.id, p);
    // Group assignments by task
    const groupedByTask = new Map();
    for (const a of schedule.assignments) {
        const arr = groupedByTask.get(a.taskId) || [];
        arr.push(a);
        groupedByTask.set(a.taskId, arr);
    }
    let html = `<div class="table-responsive"><table class="table table-assignments">
    <thead><tr>
      <th>Task</th><th>Type</th><th>Time</th><th>Slot</th>
      <th>Participant</th><th>Level</th><th>Group</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody>`;
    for (const task of schedule.tasks) {
        const taskAssignments = groupedByTask.get(task.id) || [];
        if (taskAssignments.length === 0) {
            html += `<tr class="row-warning">
        <td><strong>${task.name}</strong></td>
        <td>${taskTypeBadge(task.type)}</td>
        <td>${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}</td>
        <td colspan="6"><em class="text-danger">⚠ No assignments — Infeasible</em></td>
      </tr>`;
            continue;
        }
        taskAssignments.forEach((a, i) => {
            const p = pMap.get(a.participantId);
            const slot = task.slots.find(s => s.slotId === a.slotId);
            const isFirst = i === 0;
            html += `<tr class="${a.status === index_1.AssignmentStatus.Conflict ? 'row-error' : ''}" data-assignment-id="${a.id}">`;
            if (isFirst) {
                html += `<td rowspan="${taskAssignments.length}" class="task-cell" style="border-left:4px solid ${TASK_COLORS[task.type] || '#999'}">
          <strong>${task.name}</strong>${task.isLight ? ' <small>(Light)</small>' : ''}
        </td>
        <td rowspan="${taskAssignments.length}">${taskTypeBadge(task.type)}</td>
        <td rowspan="${taskAssignments.length}">${fmt(task.timeBlock.start)}–${fmt(task.timeBlock.end)}</td>`;
            }
            html += `<td><small>${slot?.label || a.slotId}</small></td>
        <td><strong>${p?.name || '???'}</strong></td>
        <td>${p ? levelBadge(p.level) : '—'}</td>
        <td>${p ? groupBadge(p.group) : '—'}</td>
        <td>${statusBadge(a.status)}</td>
        <td>
          <button class="btn-swap" data-assignment-id="${a.id}" data-task-id="${task.id}" title="Swap participant">⇄</button>
          <button class="btn-lock" data-assignment-id="${a.id}" title="Lock/Unlock">🔒</button>
        </td>
      </tr>`;
        });
    }
    html += '</tbody></table></div>';
    return html;
}
function renderScoreCard(schedule) {
    const s = schedule.score;
    const feasibleClass = schedule.feasible ? 'status-ok' : 'status-error';
    const feasibleText = schedule.feasible ? '✓ Feasible' : '✗ Infeasible';
    return `<div class="score-grid">
    <div class="score-card ${feasibleClass}">
      <div class="score-value">${feasibleText}</div>
      <div class="score-label">Schedule Status</div>
    </div>
    <div class="score-card">
      <div class="score-value">${s.minRestHours.toFixed(1)}h</div>
      <div class="score-label">Min Rest</div>
    </div>
    <div class="score-card">
      <div class="score-value">${s.avgRestHours.toFixed(1)}h</div>
      <div class="score-label">Avg Rest</div>
    </div>
    <div class="score-card">
      <div class="score-value">${s.restStdDev.toFixed(2)}</div>
      <div class="score-label">Rest Std Dev</div>
    </div>
    <div class="score-card">
      <div class="score-value">${s.totalPenalty.toFixed(1)}</div>
      <div class="score-label">Penalty</div>
    </div>
    <div class="score-card">
      <div class="score-value">${s.totalBonus.toFixed(1)}</div>
      <div class="score-label">Bonus</div>
    </div>
    <div class="score-card highlight">
      <div class="score-value">${s.compositeScore.toFixed(1)}</div>
      <div class="score-label">Composite Score</div>
    </div>
  </div>`;
}
function renderViolations(schedule) {
    const hard = schedule.violations.filter(v => v.severity === index_1.ViolationSeverity.Error);
    const warn = schedule.violations.filter(v => v.severity === index_1.ViolationSeverity.Warning);
    if (hard.length === 0 && warn.length === 0) {
        return '<div class="alert alert-ok">✓ No constraint violations detected.</div>';
    }
    let html = '';
    if (hard.length > 0) {
        html += `<div class="alert alert-error"><strong>Hard Violations (${hard.length})</strong><ul>`;
        for (const v of hard) {
            html += `<li><code>${v.code}</code> ${v.message}</li>`;
        }
        html += '</ul></div>';
    }
    if (warn.length > 0) {
        html += `<div class="alert alert-warn"><strong>Warnings (${warn.length})</strong><ul>`;
        for (const w of warn) {
            html += `<li><code>${w.code}</code> ${w.message}</li>`;
        }
        html += '</ul></div>';
    }
    return html;
}
function renderRestTable(schedule) {
    const profiles = (0, rest_calculator_1.computeAllRestProfiles)(schedule.participants, schedule.assignments, schedule.tasks);
    const fairness = (0, rest_calculator_1.computeRestFairness)(profiles);
    let html = `<div class="rest-summary">
    <span><strong>Global Min Rest:</strong> ${isFinite(fairness.globalMinRest) ? fairness.globalMinRest.toFixed(1) + 'h' : 'N/A'}</span>
    <span><strong>Global Avg Rest:</strong> ${isFinite(fairness.globalAvgRest) ? fairness.globalAvgRest.toFixed(1) + 'h' : 'N/A'}</span>
    <span><strong>Std Dev:</strong> ${fairness.stdDevRest.toFixed(2)}</span>
  </div>`;
    html += `<div class="table-responsive"><table class="table">
    <thead><tr>
      <th>Participant</th><th>Group</th><th>Level</th><th>Non-Light Tasks</th>
      <th>Work Hours</th><th>Min Rest</th><th>Avg Rest</th><th>Rest Gaps</th>
    </tr></thead><tbody>`;
    const sorted = [...profiles.entries()].sort((a, b) => a[1].minRestHours - b[1].minRestHours);
    for (const [pid, profile] of sorted) {
        const p = schedule.participants.find(pp => pp.id === pid);
        if (!p)
            continue;
        const minRestClass = profile.minRestHours < 4 ? 'text-danger' : profile.minRestHours < 8 ? 'text-warn' : '';
        const minRestStr = isFinite(profile.minRestHours) ? profile.minRestHours.toFixed(1) + 'h' : '—';
        const avgRestStr = isFinite(profile.avgRestHours) ? profile.avgRestHours.toFixed(1) + 'h' : '—';
        const gapsStr = profile.restGaps.length > 0
            ? profile.restGaps.map(g => g.toFixed(1) + 'h').join(', ')
            : '—';
        html += `<tr>
      <td><strong>${p.name}</strong></td>
      <td>${groupBadge(p.group)}</td>
      <td>${levelBadge(p.level)}</td>
      <td>${profile.nonLightAssignmentCount}</td>
      <td>${profile.totalWorkHours.toFixed(1)}h</td>
      <td class="${minRestClass}"><strong>${minRestStr}</strong></td>
      <td>${avgRestStr}</td>
      <td><small>${gapsStr}</small></td>
    </tr>`;
    }
    html += '</tbody></table></div>';
    return html;
}
function renderGanttChart(schedule) {
    const ganttData = (0, gantt_bridge_1.scheduleToGantt)(schedule);
    const totalMs = ganttData.timelineEndMs - ganttData.timelineStartMs;
    if (totalMs <= 0)
        return '<p>No timeline data.</p>';
    // Generate hour markers
    const startDate = new Date(ganttData.timelineStartMs);
    const endDate = new Date(ganttData.timelineEndMs);
    const totalHours = totalMs / 3600000;
    let html = `<div class="gantt-container">`;
    // Time axis
    html += `<div class="gantt-header"><div class="gantt-label-col"></div><div class="gantt-timeline-col">`;
    for (let h = 0; h <= totalHours; h += 2) {
        const pos = (h / totalHours) * 100;
        const d = new Date(ganttData.timelineStartMs + h * 3600000);
        html += `<span class="gantt-hour-mark" style="left:${pos}%">${d.getHours().toString().padStart(2, '0')}:00</span>`;
    }
    html += `</div></div>`;
    // Rows
    for (const row of ganttData.rows) {
        html += `<div class="gantt-row">
      <div class="gantt-label-col">
        <span class="gantt-name">${row.participantName}</span>
        <span class="gantt-meta">${row.group} · L${row.level}</span>
      </div>
      <div class="gantt-timeline-col">`;
        for (const block of row.blocks) {
            const left = ((block.startMs - ganttData.timelineStartMs) / totalMs) * 100;
            const width = (block.durationMs / totalMs) * 100;
            const tooltip = `${block.taskName}&#10;${new Date(block.startMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${new Date(block.endMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
            html += `<div class="gantt-block ${block.isLight ? 'gantt-light' : ''}" 
        style="left:${left}%;width:${width}%;background:${block.color}" 
        title="${tooltip}">
        <span class="gantt-block-text">${block.taskName}</span>
      </div>`;
        }
        html += `</div></div>`;
    }
    html += `</div>`;
    return html;
}
// ─── Main Render ─────────────────────────────────────────────────────────────
function renderAll() {
    const app = document.getElementById('app');
    // Initialize engine
    engine = new index_1.SchedulingEngine({ maxIterations: 2000, maxSolverTimeMs: 10000 });
    engine.addParticipants(allParticipants);
    const tasks = (0, index_1.generateDailyTasks)(BASE_DATE);
    engine.addTasks(tasks);
    // Show participants & tasks
    let html = `
    <header>
      <h1>⏱ Resource Scheduling Engine</h1>
      <p class="subtitle">Feb 15, 2026 · ${allParticipants.length} Participants · ${tasks.length} Tasks</p>
    </header>

    <section>
      <h2>📋 Participants <span class="count">${allParticipants.length}</span></h2>
      ${renderParticipantsTable()}
    </section>

    <section>
      <h2>📌 Tasks <span class="count">${tasks.length}</span></h2>
      ${renderTasksTable()}
    </section>

    <section>
      <div class="generating">
        <div class="spinner"></div>
        <span>Generating optimized schedule...</span>
      </div>
    </section>`;
    app.innerHTML = html;
    // Generate schedule (deferred to allow UI to paint)
    requestAnimationFrame(() => {
        const t0 = performance.now();
        currentSchedule = engine.generateSchedule();
        const elapsed = (performance.now() - t0).toFixed(0);
        html = `
    <header>
      <h1>⏱ Resource Scheduling Engine</h1>
      <p class="subtitle">Feb 15, 2026 · ${allParticipants.length} Participants · ${tasks.length} Tasks · Generated in ${elapsed}ms</p>
      <button id="btn-regenerate" class="btn-primary">🔄 Regenerate</button>
    </header>

    <section>
      <h2>📊 Schedule Score</h2>
      ${renderScoreCard(currentSchedule)}
    </section>

    <section>
      <h2>⚠ Constraint Violations</h2>
      ${renderViolations(currentSchedule)}
    </section>

    <section>
      <h2>📋 Assignments <span class="count">${currentSchedule.assignments.length}</span></h2>
      ${renderAssignmentsTable(currentSchedule)}
    </section>

    <section>
      <h2>📈 Gantt Timeline</h2>
      ${renderGanttChart(currentSchedule)}
    </section>

    <section>
      <h2>😴 Rest Fairness Analysis</h2>
      ${renderRestTable(currentSchedule)}
    </section>

    <section>
      <h2>📋 Participants <span class="count">${allParticipants.length}</span></h2>
      ${renderParticipantsTable()}
    </section>

    <section>
      <h2>📌 Task Definitions <span class="count">${tasks.length}</span></h2>
      ${renderTasksTable()}
    </section>`;
        app.innerHTML = html;
        // Wire up events
        document.getElementById('btn-regenerate')?.addEventListener('click', () => {
            engine.reset();
            engine.addParticipants(allParticipants);
            engine.addTasks((0, index_1.generateDailyTasks)(BASE_DATE));
            renderAll();
        });
        // Swap buttons
        document.querySelectorAll('.btn-swap').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const assignmentId = e.target.dataset.assignmentId;
                handleSwap(assignmentId);
            });
        });
        // Lock buttons
        document.querySelectorAll('.btn-lock').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const assignmentId = e.target.dataset.assignmentId;
                handleLock(assignmentId);
            });
        });
    });
}
// ─── Interactive Handlers ────────────────────────────────────────────────────
function handleSwap(assignmentId) {
    if (!currentSchedule)
        return;
    const assignment = currentSchedule.assignments.find(a => a.id === assignmentId);
    if (!assignment)
        return;
    const task = currentSchedule.tasks.find(t => t.id === assignment.taskId);
    if (!task)
        return;
    const currentP = currentSchedule.participants.find(p => p.id === assignment.participantId);
    // Build list of all participants for swap dialog
    const options = currentSchedule.participants
        .filter(p => p.id !== assignment.participantId)
        .map(p => `${p.name} (L${p.level}, ${p.group})`)
        .join('\n');
    const choice = prompt(`Swap participant in "${task.name}" slot.\nCurrently: ${currentP?.name}\n\nEnter participant name to swap in:\n\n${options}`);
    if (!choice)
        return;
    const newP = currentSchedule.participants.find(p => choice.includes(p.name) || choice === p.id);
    if (!newP) {
        alert('Participant not found.');
        return;
    }
    const result = engine.swapParticipant({ assignmentId, newParticipantId: newP.id });
    currentSchedule = engine.getSchedule();
    if (!result.valid) {
        const msgs = result.violations.map(v => `[${v.code}] ${v.message}`).join('\n');
        alert(`⚠ Swap created violations:\n\n${msgs}\n\nThe swap was applied but the schedule is now invalid.`);
    }
    renderAll();
}
function handleLock(assignmentId) {
    if (!currentSchedule)
        return;
    const assignment = currentSchedule.assignments.find(a => a.id === assignmentId);
    if (!assignment)
        return;
    if (assignment.status === index_1.AssignmentStatus.Locked) {
        engine.unlockAssignment(assignmentId);
    }
    else {
        engine.lockAssignment(assignmentId);
    }
    currentSchedule = engine.getSchedule();
    renderAll();
}
// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderAll);
//# sourceMappingURL=app.js.map