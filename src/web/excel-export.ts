/**
 * Excel Export — Hebrew / RTL via native sheet direction.
 *
 * Produces two output shapes:
 *
 *  • exportWeeklyExcel()  → one workbook with:
 *      - a summary sheet (participants × days)
 *      - one presentation sheet per operational day (mirrors the on-screen grid)
 *      - a raw-data sheet (one row per slot) with AutoFilter for sort/filter/pivot
 *
 *  • exportDailyExcel()   → one workbook with a single presentation sheet for the chosen day
 *
 * Unlike the PDF exporter, Excel shapes bidirectional text natively — we simply
 * set `worksheet.views[].rightToLeft = true` and write Hebrew strings as-is.
 * No character-reversal helper is needed.
 */

import type { Fill, Worksheet } from 'exceljs';
import { Workbook } from 'exceljs';
import type { AssignmentStatus, Level, Participant, Schedule, SlotRequirement, Task } from '../models/types';
import { getCategoryColorMap } from './config-store';
import { fmtTimeLabel, getDayWindow, getNumDays, getTasksForDay, rgbToArgb, shiftName, tint } from './export-utils';
import { computeSectionMetrics, getTaskAssignments, getUniqueStartTimes, inferColumnStrategy } from './layout-engine';

// ─── Style constants ─────────────────────────────────────────────────────────

const HEADER_FILL_ARGB = 'FF374151'; // dark slate, matches PDF `headStyles.fillColor`
const HEADER_FONT_ARGB = 'FFFFFFFF';
const DEFAULT_TASK_COLOR = '#7f8c8d';
const THIN_BORDER = {
  top: { style: 'thin' as const, color: { argb: 'FFD2D2D2' } },
  bottom: { style: 'thin' as const, color: { argb: 'FFD2D2D2' } },
  left: { style: 'thin' as const, color: { argb: 'FFD2D2D2' } },
  right: { style: 'thin' as const, color: { argb: 'FFD2D2D2' } },
};

function solidFill(argb: string): Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** Sanitise a string for use as an Excel sheet name (≤31 chars, no `\/*?:[]`). */
function safeSheetName(raw: string): string {
  const cleaned = raw.replace(/[\\/*?:[\]]/g, '-').trim();
  return (cleaned || 'Sheet').substring(0, 31);
}

/** Format a `Level` enum value as `L0` / `L2` / etc. */
function fmtLevel(l: Level | undefined): string {
  return l == null ? '' : `L${l}`;
}

/** Format a participant's status enum, or empty if no assignment. */
function fmtStatus(s: AssignmentStatus | undefined): string {
  return s ?? '';
}

// ─── Presentation sheet (one per day) ────────────────────────────────────────

/**
 * Render a single operational day onto a worksheet as a vertically stacked
 * set of section tables. Uses the same column strategies as the on-screen
 * layout engine, so output structure matches what the user sees.
 */
function buildDaySheet(ws: Worksheet, schedule: Schedule, dayIndex: number, dayStartHour: number): void {
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 2 }];
  ws.pageSetup.orientation = 'landscape';
  ws.pageSetup.fitToPage = true;
  ws.pageSetup.margins = { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 };

  const { start: dayStart } = getDayWindow(schedule, dayIndex, dayStartHour);
  const dayTasks = getTasksForDay(schedule, dayIndex, dayStartHour);
  const categoryColors = getCategoryColorMap();

  // Title row (merged later once we know the widest section)
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `יום ${dayIndex}`;
  titleCell.font = { bold: true, size: 14 };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 22;

  if (dayTasks.length === 0) {
    const empty = ws.getCell(3, 1);
    empty.value = 'אין משימות ביום זה';
    empty.font = { italic: true, color: { argb: 'FF888888' } };
    empty.alignment = { horizontal: 'center' };
    ws.mergeCells(1, 1, 1, 6);
    ws.mergeCells(3, 1, 3, 6);
    ws.getColumn(1).width = 14;
    for (let c = 2; c <= 6; c++) ws.getColumn(c).width = 18;
    return;
  }

  const sections = computeSectionMetrics(dayTasks);
  let currentRow = 3; // leave row 2 blank under the title
  let maxCols = 2;

  for (const section of sections) {
    const strategy = inferColumnStrategy(section.tasks);
    const columns = strategy(section.tasks);
    if (columns.length === 0) continue;

    const uniqueTimes = getUniqueStartTimes(section.tasks);
    const totalShifts = uniqueTimes.length;
    const sectionColor = categoryColors[section.id] || section.tasks[0]?.color || DEFAULT_TASK_COLOR;
    const tintedHeader = rgbToArgb(tint(sectionColor, 0.55));
    const tintedCell = rgbToArgb(tint(sectionColor));

    const totalCols = columns.length + 1; // + time column
    maxCols = Math.max(maxCols, totalCols);

    // Section title row (merged across all columns)
    const sectionTitleCell = ws.getCell(currentRow, 1);
    sectionTitleCell.value = section.title;
    sectionTitleCell.font = { bold: true, size: 12 };
    sectionTitleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    sectionTitleCell.fill = solidFill(tintedHeader);
    sectionTitleCell.border = THIN_BORDER;
    ws.mergeCells(currentRow, 1, currentRow, totalCols);
    ws.getRow(currentRow).height = 20;
    currentRow++;

    // Header row: [ זמן | col1 | col2 | ... ]
    const headerRow = ws.getRow(currentRow);
    const headerValues = ['זמן', ...columns.map((c) => c.header)];
    for (let i = 0; i < headerValues.length; i++) {
      const cell = headerRow.getCell(i + 1);
      cell.value = headerValues[i];
      cell.font = { bold: true, color: { argb: HEADER_FONT_ARGB } };
      cell.fill = solidFill(HEADER_FILL_ARGB);
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = THIN_BORDER;
    }
    headerRow.height = 18;
    currentRow++;

    // Data rows — one row per unique start time
    for (const timeNum of uniqueTimes) {
      const time = new Date(timeNum);
      const timeTasks = section.tasks.filter((t) => new Date(t.timeBlock.start).getTime() === timeNum);
      const row = ws.getRow(currentRow);

      // Time cell
      const timeCell = row.getCell(1);
      timeCell.value = fmtTimeLabel(time, totalShifts);
      timeCell.font = { bold: true };
      timeCell.alignment = { horizontal: 'center', vertical: 'middle' };
      timeCell.border = THIN_BORDER;

      // Data cells, one per column definition
      let maxCardsInRow = 1;
      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        const names: string[] = [];
        for (const task of timeTasks) {
          const allSlots = getTaskAssignments(task, schedule);
          const matched = col.matchSlots(task, allSlots);
          for (const s of matched) {
            names.push(s.participant?.name ?? '(פנוי)');
          }
        }
        const cell = row.getCell(c + 2);
        cell.value = names.length ? names.join('\n') : '—';
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = THIN_BORDER;
        if (names.length) {
          cell.fill = solidFill(tintedCell);
        } else {
          cell.font = { color: { argb: 'FFBEBEBE' } };
        }
        maxCardsInRow = Math.max(maxCardsInRow, names.length || 1);
      }
      row.height = Math.max(22, maxCardsInRow * 15 + 6);
      currentRow++;
    }

    // Blank separator row between sections
    currentRow++;
  }

  // Now merge the title row across the widest section
  if (maxCols > 1) ws.mergeCells(1, 1, 1, maxCols);

  // Column widths
  ws.getColumn(1).width = 14; // time
  for (let c = 2; c <= maxCols; c++) {
    ws.getColumn(c).width = 22;
  }
}

// ─── Summary sheet ───────────────────────────────────────────────────────────

/**
 * Build a participants × days matrix. Each cell lists the tasks that
 * participant is assigned to that day, joined by `, `.
 */
function buildSummarySheet(ws: Worksheet, schedule: Schedule, dayStartHour: number): void {
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1, xSplit: 1 }];

  const numDays = getNumDays(schedule, dayStartHour);

  // Precompute day → tasks so we don't recompute per participant
  const tasksByDay: Task[][] = [];
  const dayDates: Date[] = [];
  for (let d = 1; d <= numDays; d++) {
    tasksByDay.push(getTasksForDay(schedule, d, dayStartHour));
    dayDates.push(getDayWindow(schedule, d, dayStartHour).start);
  }

  // Header row
  const headerValues = ['משתתף', ...dayDates.map((_, i) => `יום ${i + 1}`)];
  const headerRow = ws.addRow(headerValues);
  headerRow.font = { bold: true, color: { argb: HEADER_FONT_ARGB } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.height = 22;
  for (let i = 1; i <= headerValues.length; i++) {
    headerRow.getCell(i).fill = solidFill(HEADER_FILL_ARGB);
    headerRow.getCell(i).border = THIN_BORDER;
  }

  // Participants sorted by name for a deterministic matrix
  const participants = [...schedule.participants].sort((a, b) => a.name.localeCompare(b.name, 'he'));

  for (const p of participants) {
    const rowValues: (string | number)[] = [p.name];
    for (let d = 0; d < numDays; d++) {
      const tasks = tasksByDay[d];
      const taskNames = new Set<string>();
      for (const t of tasks) {
        const has = schedule.assignments.some((a) => a.taskId === t.id && a.participantId === p.id);
        if (has) taskNames.add(t.sourceName || t.name);
      }
      rowValues.push([...taskNames].join(', '));
    }
    const row = ws.addRow(rowValues);
    row.getCell(1).font = { bold: true };
    row.getCell(1).alignment = { horizontal: 'right', vertical: 'middle' };
    row.getCell(1).border = THIN_BORDER;
    for (let c = 2; c <= numDays + 1; c++) {
      const cell = row.getCell(c);
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.border = THIN_BORDER;
    }
    row.height = Math.max(20, 16);
  }

  ws.getColumn(1).width = 22;
  for (let c = 2; c <= numDays + 1; c++) ws.getColumn(c).width = 20;
}

// ─── Raw data sheet ──────────────────────────────────────────────────────────

/**
 * Flat assignments table: one row per `SlotRequirement` (filled or unfilled).
 * Times are written as real `Date` values with `hh:mm` number format so
 * sort/filter/pivot work correctly. Includes AutoFilter.
 *
 * Note: calendar dates and weekdays are intentionally omitted — schedules are
 * day-index based, so we expose `יום` (index 1..N) only.
 */
function buildRawDataSheet(ws: Worksheet, schedule: Schedule, dayStartHour: number): void {
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];

  const headers = [
    'יום',
    'התחלה',
    'סיום',
    'משמרת',
    'קטגוריה',
    'משימה',
    'תת-צוות',
    'תווית מקום',
    'רמות מותרות',
    'תעודות נדרשות',
    'משתתף',
    'קבוצה',
    'רמה',
    'תעודות משתתף',
    'סטטוס',
    'taskId',
    'slotId',
    'participantId',
  ];
  ws.addRow(headers);

  const numDays = getNumDays(schedule, dayStartHour);
  for (let d = 1; d <= numDays; d++) {
    const dayTasks = getTasksForDay(schedule, d, dayStartHour);
    for (const task of dayTasks) {
      const assignedSlots = getTaskAssignments(task, schedule);
      for (const as of assignedSlots) {
        const slot: SlotRequirement = as.slot;
        const p: Participant | undefined = as.participant;
        const startDt = new Date(task.timeBlock.start);
        const endDt = new Date(task.timeBlock.end);
        ws.addRow([
          d,
          startDt,
          endDt,
          shiftName(startDt),
          task.displayCategory ?? (task.sourceName || task.name).toLowerCase(),
          task.sourceName || task.name,
          slot.subTeamLabel || slot.subTeamId || '',
          slot.label || '',
          slot.acceptableLevels.map((l) => fmtLevel(l.level)).join('/'),
          slot.requiredCertifications.join(', '),
          p?.name || '',
          p?.group || '',
          fmtLevel(p?.level),
          p ? p.certifications.join(', ') : '',
          fmtStatus(as.assignment?.status),
          task.id,
          slot.slotId,
          p?.id || '',
        ]);
      }
    }
  }

  // Header styling
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: HEADER_FONT_ARGB } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  for (let i = 1; i <= headers.length; i++) {
    headerRow.getCell(i).fill = solidFill(HEADER_FILL_ARGB);
  }

  // Column widths (roughly tuned for content)
  const widths = [5, 12, 9, 9, 10, 14, 18, 14, 18, 14, 20, 18, 14, 7, 22, 12, 16, 16, 16];
  for (let i = 0; i < headers.length; i++) {
    ws.getColumn(i + 1).width = widths[i] ?? 14;
  }

  // Number formats for time columns (התחלה, סיום)
  ws.getColumn(3).numFmt = 'hh:mm';
  ws.getColumn(4).numFmt = 'hh:mm';

  // Alignment for data rows
  const lastRow = ws.rowCount;
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= headers.length; c++) {
      row.getCell(c).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }
  }

  // AutoFilter on all columns
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };
}

// ─── Download helper ─────────────────────────────────────────────────────────

async function triggerDownload(workbook: Workbook, filename: string): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * Build and download a full-week workbook:
 *   - summary sheet (participants × days)
 *   - one presentation sheet per operational day
 *   - raw-data sheet with AutoFilter
 */
export async function exportWeeklyExcel(schedule: Schedule, dayStartHour: number = 5): Promise<void> {
  const workbook = new Workbook();
  workbook.creator = 'Garden Manager';
  workbook.created = new Date();

  // 1. Summary sheet (first tab)
  const summaryWs = workbook.addWorksheet(safeSheetName('סיכום'));
  buildSummarySheet(summaryWs, schedule, dayStartHour);

  // 2. One presentation sheet per day
  const numDays = getNumDays(schedule, dayStartHour);
  for (let d = 1; d <= numDays; d++) {
    const sheetName = safeSheetName(`יום ${d}`);
    const ws = workbook.addWorksheet(sheetName);
    buildDaySheet(ws, schedule, d, dayStartHour);
  }

  // 3. Raw data sheet (last tab)
  const rawWs = workbook.addWorksheet(safeSheetName('נתונים גולמיים'));
  buildRawDataSheet(rawWs, schedule, dayStartHour);

  await triggerDownload(workbook, 'GardenManager-Schedule.xlsx');
}

/**
 * Build and download a single-day workbook with one presentation sheet.
 */
export async function exportDailyExcel(schedule: Schedule, dayIndex: number, dayStartHour: number = 5): Promise<void> {
  const workbook = new Workbook();
  workbook.creator = 'Garden Manager';
  workbook.created = new Date();

  const sheetName = safeSheetName(`יום ${dayIndex}`);
  const ws = workbook.addWorksheet(sheetName);
  buildDaySheet(ws, schedule, dayIndex, dayStartHour);

  await triggerDownload(workbook, `GardenManager-Day-${dayIndex}.xlsx`);
}
