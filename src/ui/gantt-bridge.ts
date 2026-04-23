/**
 * Gantt UI Bridge - Transforms schedule data into a format suitable
 * for rendering a Gantt-style timeline view.
 */

import {
  Assignment,
  AssignmentStatus,
  type GanttBlock,
  type GanttData,
  type GanttRow,
  type Participant,
  type Schedule,
  type Task,
} from '../models/types';
import { computeTaskEffectiveHours } from '../shared/utils/load-weighting';
import { blockDurationMinutes, getTimelineBounds } from '../shared/utils/time-utils';
import { describeSlot } from '../utils/date-utils';

const STATUS_OPACITY: Record<AssignmentStatus, number> = {
  [AssignmentStatus.Scheduled]: 1.0,
  [AssignmentStatus.Manual]: 1.0,
  [AssignmentStatus.Conflict]: 0.5,
  [AssignmentStatus.Frozen]: 0.4,
};

/**
 * Generate a CSS color with opacity for a task block.
 */
function getBlockColor(baseColor: string, status: AssignmentStatus): string {
  const opacity = STATUS_OPACITY[status] || 1.0;
  if (opacity === 1.0) return baseColor;
  // Convert hex to rgba
  const hex = baseColor.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// ─── Gantt Data Generation ───────────────────────────────────────────────────

/**
 * Convert a Schedule into GanttData for rendering.
 */
export function scheduleToGantt(schedule: Schedule): GanttData {
  const { tasks, participants, assignments } = schedule;

  const taskMap = new Map<string, Task>();
  for (const t of tasks) taskMap.set(t.id, t);

  const pMap = new Map<string, Participant>();
  for (const p of participants) pMap.set(p.id, p);

  // Build rows keyed by participant
  const rowMap = new Map<string, GanttRow>();

  for (const p of participants) {
    rowMap.set(p.id, {
      participantId: p.id,
      participantName: p.name,
      group: p.group,
      level: p.level,
      blocks: [],
    });
  }

  // Populate blocks
  for (const a of assignments) {
    const task = taskMap.get(a.taskId);
    if (!task) continue;

    const row = rowMap.get(a.participantId);
    if (!row) continue;

    const block: GanttBlock = {
      assignmentId: a.id,
      taskId: task.id,
      taskName: task.name,
      startMs: task.timeBlock.start.getTime(),
      endMs: task.timeBlock.end.getTime(),
      durationMs: task.timeBlock.end.getTime() - task.timeBlock.start.getTime(),
      status: a.status,
      isZeroLoad: computeTaskEffectiveHours(task) === 0,
      color: getBlockColor(task.color || '#95A5A6', a.status),
    };

    row.blocks.push(block);
  }

  // Sort blocks within each row by start time
  for (const row of rowMap.values()) {
    row.blocks.sort((a, b) => a.startMs - b.startMs);
  }

  // Timeline bounds
  const allBlocks = tasks.map((t) => t.timeBlock);
  const bounds = getTimelineBounds(allBlocks);

  // Guard against empty task list — use sensible defaults
  const timelineStartMs = bounds?.start.getTime() ?? Date.now();
  const timelineEndMs = bounds?.end.getTime() ?? Date.now();
  const totalDurationMs = timelineEndMs - timelineStartMs;

  // Auto-scale: aim for ~1200px wide chart
  const targetPx = 1200;
  const scaleMinPerPx = totalDurationMs > 0 ? totalDurationMs / (1000 * 60) / targetPx : 1;

  const rows = [...rowMap.values()];

  // Sort rows by group then name
  rows.sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.participantName.localeCompare(b.participantName);
  });

  return {
    rows,
    timelineStartMs,
    timelineEndMs,
    scaleMinPerPx,
  };
}

// ─── Gantt Summary for Console/Text ──────────────────────────────────────────

/**
 * Generate ASCII representation of the Gantt chart for console output.
 */
export function ganttToAscii(data: GanttData, widthChars: number = 120): string {
  const lines: string[] = [];
  const nameWidth = 25;
  const chartWidth = widthChars - nameWidth - 3; // margins

  const totalMs = data.timelineEndMs - data.timelineStartMs;
  if (totalMs <= 0) return 'No timeline data.';

  const msPerChar = totalMs / chartWidth;

  // Header
  const startDate = new Date(data.timelineStartMs);
  const endDate = new Date(data.timelineEndMs);
  lines.push(`Timeline: ${startDate.toISOString().slice(0, 16)} → ${endDate.toISOString().slice(0, 16)}`);
  lines.push('─'.repeat(widthChars));

  // Hour markers
  let headerLine = ' '.repeat(nameWidth) + ' │';
  const startHour = startDate.getHours();
  for (let i = 0; i < chartWidth; i++) {
    const ms = data.timelineStartMs + i * msPerChar;
    const d = new Date(ms);
    if (d.getMinutes() < msPerChar / (1000 * 60)) {
      const h = d.getHours().toString().padStart(2, '0');
      headerLine += h;
      i++; // skip next char (we used 2)
    } else {
      headerLine += ' ';
    }
  }
  lines.push(headerLine);
  lines.push('─'.repeat(widthChars));

  // Rows
  for (const row of data.rows) {
    const label = `${row.participantName} (${row.group})`.padEnd(nameWidth).slice(0, nameWidth);
    const chart = new Array(chartWidth).fill('·');

    for (const block of row.blocks) {
      const startChar = Math.floor((block.startMs - data.timelineStartMs) / msPerChar);
      const endChar = Math.floor((block.endMs - data.timelineStartMs) / msPerChar);

      const symbol = (block.taskName?.[0] || '?').toUpperCase();
      for (let c = Math.max(0, startChar); c < Math.min(chartWidth, endChar); c++) {
        chart[c] = symbol;
      }
    }

    lines.push(`${label} │${chart.join('')}`);
  }

  // Legend — build from unique task names in data
  lines.push('─'.repeat(widthChars));
  const taskNames = new Set<string>();
  for (const row of data.rows) {
    for (const block of row.blocks) {
      taskNames.add(block.taskName);
    }
  }
  const legend = [...taskNames].map((name) => `${(name[0] || '?').toUpperCase()}=${name}`).join('  ');
  lines.push(`Legend: ${legend}  ·=Free`);

  return lines.join('\n');
}

// ─── JSON Export for Web UI ──────────────────────────────────────────────────

/**
 * Export GanttData as a JSON string for consumption by web frameworks.
 */
export function exportGanttJson(data: GanttData): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Build a task summary table from schedule data.
 */
export function buildTaskSummary(schedule: Schedule): string {
  const lines: string[] = [];
  const taskMap = new Map<string, Task>();
  for (const t of schedule.tasks) taskMap.set(t.id, t);
  const pMap = new Map<string, Participant>();
  for (const p of schedule.participants) pMap.set(p.id, p);

  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║                    TASK ASSIGNMENT SUMMARY                  ║');
  lines.push('╠══════════════════════════════════════════════════════════════╣');

  for (const task of schedule.tasks) {
    const taskAssignments = schedule.assignments.filter((a) => a.taskId === task.id);
    const start = task.timeBlock.start.toISOString().slice(11, 16);
    const end = task.timeBlock.end.toISOString().slice(11, 16);

    lines.push(`║ ${task.name.padEnd(20)} ${start}-${end}  [${task.sourceName || task.name}]`.padEnd(63) + '║');

    for (const a of taskAssignments) {
      const p = pMap.get(a.participantId);
      const slot = task.slots.find((s) => s.slotId === a.slotId);
      if (p) {
        const status = a.status !== AssignmentStatus.Scheduled ? ` [${a.status}]` : '';
        lines.push(
          `║   → ${p.name} (L${p.level}, ${p.group})${status}  <${describeSlot(slot?.label, task.timeBlock)}>`.padEnd(
            63,
          ) + '║',
        );
      }
    }
    lines.push('║' + '─'.repeat(62) + '║');
  }

  lines.push('╚══════════════════════════════════════════════════════════════╝');
  return lines.join('\n');
}
