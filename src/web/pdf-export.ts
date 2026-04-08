/**
 * Professional PDF Export — Hebrew / RTL Support
 *
 * Grid-based spatial layout that mirrors the on-screen CSS grid:
 *   ┌─────────────────────┬──────────────┐
 *   │  Patrol (Karov +    │   Hamama     │
 *   │  Karovit + Adanit)  ├──────────────┤
 *   │     (2/3 width)     │   Aruga      │
 *   │                     │   (1/3 width)│
 *   ├─────────────────────┴──────────────┤
 *   │  Mamtera  │  Shemesh               │
 *   └───────────┴────────────────────────┘
 *
 * All columns, rows, and table presence are derived dynamically from
 * schedule data — if a task type is absent its region collapses, and
 * if slot counts change extra columns appear automatically.
 *
 * Uses jsPDF + jsPDF-AutoTable with an embedded Rubik TTF font for
 * correct Hebrew (Right-to-Left) rendering.
 */

import { addDays } from 'date-fns';
import { jsPDF } from 'jspdf';
import autoTable, { type CellDef, type UserOptions } from 'jspdf-autotable';
import type { Schedule, Task } from '../models/types';
import { fmtTime, HEBREW_DAYS } from '../utils/date-utils';
import {
  assignRows,
  computeSectionMetrics,
  generateGridTemplate,
  getTaskAssignments,
  getUniqueStartTimes,
  SectionMetrics,
  SectionPlacement,
} from './layout-engine';
import { RUBIK_FONT_BASE64 } from './utils/rubik-font-data';

/** Resolve a task's display category. */
function getDisplayCategory(task: Task): string {
  if (task.displayCategory) return task.displayCategory;
  return (task.sourceName || task.name || 'custom').toLowerCase();
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_MARGIN = 8; // mm from each edge
const COL_GAP = 4; // mm between grid columns
const ROW_GAP = 3; // mm between grid rows
const TABLE_LABEL_OFFSET = 3; // mm from label text to table top

/** Named Hebrew shift labels by start-hour ranges */
const SHIFT_NAMES: Record<number, string> = {
  5: 'בוקר',
  6: 'בוקר',
  7: 'בוקר',
  8: 'בוקר',
  12: 'צהריים',
  13: 'צהריים',
  14: 'צהריים',
  17: 'ערב',
  18: 'ערב',
  19: 'ערב',
  20: 'ערב',
  21: 'לילה',
  22: 'לילה',
  23: 'לילה',
};

/** Hex colour string → [R, G, B] tuple */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

/** Light tint for cell backgrounds */
function tint(hex: string, f = 0.82): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [Math.round(r + (255 - r) * f), Math.round(g + (255 - g) * f), Math.round(b + (255 - b) * f)];
}

// ─── Hebrew RTL helper ───────────────────────────────────────────────────────

function rtl(text: string): string {
  if (!text) return text;
  const hebrewRange = /[\u0590-\u05FF\uFB1D-\uFB4F]/;
  const segments: { text: string; isHebrew: boolean }[] = [];
  let current = '';
  let currentIsHebrew = false;

  for (const ch of text) {
    const isHeb = hebrewRange.test(ch);
    const isNeutral = /[\s\-–—:;,.!?()[\]{}/\\#@'"]/.test(ch);
    if (current.length === 0) {
      currentIsHebrew = isHeb;
      current = ch;
    } else if (isNeutral) {
      current += ch;
    } else if (isHeb === currentIsHebrew) {
      current += ch;
    } else {
      segments.push({ text: current, isHebrew: currentIsHebrew });
      current = ch;
      currentIsHebrew = isHeb;
    }
  }
  if (current) segments.push({ text: current, isHebrew: currentIsHebrew });

  return segments
    .map((s) => (s.isHebrew ? [...s.text].reverse().join('') : s.text))
    .reverse()
    .join('');
}

// ─── PDF helpers ─────────────────────────────────────────────────────────────

function createDoc(): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.addFileToVFS('Rubik-Regular.ttf', RUBIK_FONT_BASE64);
  doc.addFont('Rubik-Regular.ttf', 'Rubik', 'normal');
  doc.setFont('Rubik', 'normal');
  return doc;
}

function getDayWindow(schedule: Schedule, dayIndex: number, dayStartHour: number = 5): { start: Date; end: Date } {
  const allStarts = schedule.tasks.map((t) => new Date(t.timeBlock.start).getTime());
  const scheduleStart = new Date(Math.min(...allStarts));
  const dayAnchor = addDays(scheduleStart, dayIndex - 1);
  const dayStart = new Date(dayAnchor);
  if (dayStart.getHours() < dayStartHour) dayStart.setDate(dayStart.getDate() - 1);
  dayStart.setHours(dayStartHour, 0, 0, 0);
  return { start: dayStart, end: addDays(dayStart, 1) };
}

function getTasksForDay(schedule: Schedule, dayIndex: number, dayStartHour: number = 5): Task[] {
  const { start, end } = getDayWindow(schedule, dayIndex, dayStartHour);
  return schedule.tasks.filter((t) => {
    const s = new Date(t.timeBlock.start).getTime();
    return s >= start.getTime() && s < end.getTime();
  });
}

function getNumDays(schedule: Schedule): number {
  const starts = schedule.tasks.map((t) => new Date(t.timeBlock.start).getTime());
  const ends = schedule.tasks.map((t) => new Date(t.timeBlock.end).getTime());
  return Math.ceil((Math.max(...ends) - Math.min(...starts)) / (24 * 3600_000));
}

/** Format time — if ≤ 2 unique shifts in a category, use named labels; otherwise HH:MM */
function fmtTimeLabel(d: Date, totalShifts: number): string {
  if (totalShifts <= 2) {
    const name = SHIFT_NAMES[d.getHours()];
    if (name) return rtl(name);
  }
  return fmtTime(d);
}

/** Draw centred page title + day subtitle. Returns Y below the separator line. */
function drawTitle(doc: jsPDF, dayTitle: string, daySubtitle: string): number {
  const w = doc.internal.pageSize.getWidth();

  // Main title — "ניהול גינה" centred
  doc.setFontSize(16);
  doc.setTextColor(55, 65, 81);
  doc.text(rtl('ניהול גינה'), w / 2, 11, { align: 'center' });

  // Day subtitle right-aligned
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text(rtl(dayTitle), w - PAGE_MARGIN, 18, { align: 'right' });

  doc.setFontSize(7);
  doc.setTextColor(150, 150, 150);
  doc.text(rtl(daySubtitle), w - PAGE_MARGIN, 22, { align: 'right' });

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(PAGE_MARGIN, 24, w - PAGE_MARGIN, 24);
  return 27;
}

/** Shared compact table defaults — positioned at (x, y) with a fixed width */
function tblDefaults(doc: jsPDF, y: number, fontSize = 7): Partial<UserOptions> {
  return {
    startY: y,
    theme: 'grid',
    styles: {
      font: 'Rubik',
      fontStyle: 'normal',
      fontSize,
      halign: 'right',
      cellPadding: { top: 1.8, bottom: 1.8, left: 1, right: 1 },
      lineColor: [210, 210, 210],
      lineWidth: 0.2,
      overflow: 'ellipsize',
    },
    headStyles: {
      fillColor: [55, 65, 81],
      textColor: [255, 255, 255],
      fontSize,
      halign: 'center',
      fontStyle: 'normal',
      cellPadding: 1.5,
    },
    margin: { right: PAGE_MARGIN, left: PAGE_MARGIN, top: PAGE_MARGIN, bottom: PAGE_MARGIN },
    didParseCell: (data: any) => {
      data.cell.styles.font = 'Rubik';
    },
  };
}

// ─── Grid Layout Engine (powered by shared layout-engine.ts) ────────────────

/** Describes a positioned table region on the page */
interface GridRegion {
  key: string;
  label: string;
  tasks: Task[];
  color: string;
  x: number;
  y: number;
  width: number;
}

/** Convert layout-engine grid template to positioned PDF regions grouped by row. */
function computeGridLayoutSmart(dayTasks: Task[], pageW: number, topY: number): { rows: GridRegion[][] } {
  const sections = computeSectionMetrics(dayTasks);
  if (sections.length === 0) return { rows: [] };

  const layoutRows = assignRows(sections);
  const template = generateGridTemplate(layoutRows);
  const usable = pageW - 2 * PAGE_MARGIN;
  const unitWidth = usable / 12;

  // Group placements by row
  const placementMap = new Map(template.placements.map((p) => [p.sectionId, p]));
  const rowMap = new Map<number, GridRegion[]>();

  for (const section of sections) {
    const placement = placementMap.get(section.id);
    if (!placement) continue;

    // Determine color from the first task in the section
    const color = section.tasks[0]?.color || '#7f8c8d';

    // Compute x and width from grid placement (RTL: higher colStart = more to the left on page,
    // but CSS grid with direction:rtl handles this. For PDF, we position right-to-left manually.)
    // In PDF RTL: rightmost section = highest x. Grid column 1 = rightmost.
    const x = pageW - PAGE_MARGIN - (placement.colStart - 1 + placement.colSpan) * unitWidth;
    const width = placement.colSpan * unitWidth - (placement.colSpan < 12 ? COL_GAP / 2 : 0);

    const region: GridRegion = {
      key: section.id,
      label: section.title,
      tasks: section.tasks,
      color,
      x,
      y: topY, // Will be adjusted per-row during rendering
      width,
    };

    if (!rowMap.has(placement.row)) rowMap.set(placement.row, []);
    rowMap.get(placement.row)!.push(region);
  }

  // Convert to ordered array of rows
  const rows: GridRegion[][] = [];
  const rowNums = [...rowMap.keys()].sort((a, b) => a - b);
  for (const rowNum of rowNums) {
    rows.push(rowMap.get(rowNum)!);
  }

  return { rows };
}

// ─── Unified PDF Section Table Renderer ─────────────────────────────────────

/**
 * Render any section's table at a given PDF region, using the same column
 * strategy logic as the on-screen layout engine. Returns the finalY.
 */
function renderSectionTablePdf(
  doc: jsPDF,
  tasks: Task[],
  schedule: Schedule,
  region: GridRegion,
  fontSize: number,
): number {
  if (tasks.length === 0) return region.y;

  // Section label
  doc.setFontSize(fontSize);
  doc.setTextColor(80, 80, 80);
  doc.text(rtl(region.label), region.x + region.width - 1, region.y, { align: 'right' });
  const tableY = region.y + TABLE_LABEL_OFFSET;

  // ── Infer column strategy from slot properties (mirrors layout-engine logic) ──
  const hasTeams = tasks.some((t) => t.slots.some((s) => s.subTeamId != null));
  const hasMultipleSources = new Set(tasks.map((t) => t.sourceName || t.name)).size > 1;
  const hasSubTeams = tasks.some((t) => t.slots.some((s) => s.subTeamId));

  type ColDef = { header: string; build: (timeNum: number) => { content: string; color: string } };
  const columns: ColDef[] = [];

  if (hasTeams || hasMultipleSources) {
    // ── Multi-source split strategy ──
    const teamTasks = tasks.filter((t) => t.slots.some((s) => s.subTeamId != null));
    const nonTeamTasks = tasks.filter((t) => !t.slots.some((s) => s.subTeamId != null));
    const nonTeamBySource = new Map<string, Task[]>();
    for (const t of nonTeamTasks) {
      const key = t.sourceName || t.name;
      if (!nonTeamBySource.has(key)) nonTeamBySource.set(key, []);
      nonTeamBySource.get(key)!.push(t);
    }

    // Non-team source columns
    for (const [sourceKey, sourceTasks] of nonTeamBySource) {
      columns.push({
        header: sourceKey,
        build: (timeNum) => {
          const atTime = sourceTasks.filter((tk) => new Date(tk.timeBlock.start).getTime() === timeNum);
          const names = atTime
            .flatMap((tk) =>
              getTaskAssignments(tk, schedule)
                .filter((s) => s.participant)
                .map((s) => rtl(s.participant!.name)),
            )
            .join('\n\n');
          return { content: names || '—', color: atTime[0]?.color || '#7f8c8d' };
        },
      });
    }

    // Team-based columns (deterministic order)
    const allTeamSlots = teamTasks.flatMap((tk) => tk.slots);
    const distinctTeamIds = [...new Set(allTeamSlots.map((s) => s.subTeamId).filter(Boolean))] as string[];
    distinctTeamIds.sort();

    for (const teamId of distinctTeamIds) {
      const label = allTeamSlots.find((s) => s.subTeamId === teamId)?.subTeamLabel ?? teamId;
      columns.push({
        header: label,
        build: (timeNum) => {
          const atTime = teamTasks.filter((tk) => new Date(tk.timeBlock.start).getTime() === timeNum);
          const names = atTime
            .flatMap((tk) =>
              getTaskAssignments(tk, schedule)
                .filter((s) => s.slot.subTeamId === teamId && s.participant)
                .map((s) => rtl(s.participant!.name)),
            )
            .join('\n\n');
          return { content: names || '—', color: atTime[0]?.color || '#7f8c8d' };
        },
      });
    }
  } else if (hasSubTeams) {
    // ── Sub-team strategy ──
    const subTeamIds: string[] = [];
    const seen = new Set<string>();
    for (const t of tasks) {
      for (const s of t.slots) {
        const id = s.subTeamId ?? '';
        if (!seen.has(id)) {
          seen.add(id);
          subTeamIds.push(id);
        }
      }
    }

    const categoryLabel = region.label;
    for (let i = 0; i < subTeamIds.length; i++) {
      const stId = subTeamIds[i];
      // Try to find a label from slot metadata
      let label: string | undefined;
      for (const t of tasks) {
        const sample = t.slots.find((s) => (s.subTeamId ?? '') === stId);
        if (sample?.label) {
          label = sample.label;
          break;
        }
      }
      if (!label) {
        label = subTeamIds.length === 1 ? categoryLabel : `${categoryLabel} #${subTeamIds.length - i}`;
      }

      const capturedStId = stId;
      columns.push({
        header: label,
        build: (timeNum) => {
          const atTime = tasks.filter((tk) => new Date(tk.timeBlock.start).getTime() === timeNum);
          const names = atTime
            .flatMap((tk) =>
              getTaskAssignments(tk, schedule)
                .filter((s) => (s.slot.subTeamId ?? '') === capturedStId && s.participant)
                .map((s) => rtl(s.participant!.name)),
            )
            .join('\n\n');
          return { content: names || '—', color: atTime[0]?.color || '#7f8c8d' };
        },
      });
    }
  } else {
    // ── Flat strategy ──
    columns.push({
      header: region.label,
      build: (timeNum) => {
        const atTime = tasks.filter((tk) => new Date(tk.timeBlock.start).getTime() === timeNum);
        const names = atTime
          .flatMap((tk) =>
            getTaskAssignments(tk, schedule)
              .filter((s) => s.participant)
              .map((s) => rtl(s.participant!.name)),
          )
          .join('\n\n');
        return { content: names || '—', color: atTime[0]?.color || '#7f8c8d' };
      },
    });
  }

  if (columns.length === 0) return region.y;

  const uniqueTimes = getUniqueStartTimes(tasks);
  const totalShifts = uniqueTimes.length;

  // Build header (data columns + time column rightmost)
  const head: CellDef[] = [
    ...columns.map((c) => ({ content: rtl(c.header), styles: { halign: 'center' as const } })),
    { content: rtl('זמן'), styles: { halign: 'center' as const } },
  ];

  const emptyStyle = { halign: 'center' as const, textColor: [190, 190, 190] as [number, number, number] };
  const filledStyle = (hexColor: string) => ({
    halign: 'center' as const,
    fillColor: tint(hexColor) as [number, number, number],
  });

  const body: CellDef[][] = uniqueTimes.map((timeNum) => {
    const time = new Date(timeNum);
    const cells: CellDef[] = columns.map((col) => {
      const { content, color: cellColor } = col.build(timeNum);
      return { content, styles: content === '—' ? emptyStyle : filledStyle(cellColor) };
    });
    cells.push({ content: fmtTimeLabel(time, totalShifts), styles: { halign: 'center' as const } });
    return cells;
  });

  // Column widths: time col = 14mm, data cols share the rest
  const timeW = 14;
  const dataColW = columns.length > 0 ? (region.width - timeW) / columns.length : region.width - timeW;
  const colStyles: Record<number, Partial<{ cellWidth: number }>> = {};
  for (let i = 0; i < columns.length; i++) colStyles[i] = { cellWidth: dataColW };
  colStyles[columns.length] = { cellWidth: timeW };

  autoTable(doc, {
    ...tblDefaults(doc, tableY, fontSize),
    head: [head],
    body,
    tableWidth: region.width,
    margin: { left: region.x, right: doc.internal.pageSize.getWidth() - region.x - region.width },
    columnStyles: colStyles,
  });

  return (doc as any).lastAutoTable.finalY;
}

// ─── Daily Detail Export (Grid Layout) ───────────────────────────────────────

/**
 * Smart font-size selection based on schedule density.
 *
 * Considers three dimensions:
 *  1. Max time-rows in any single category (vertical pressure)
 *  2. Max names per cell — i.e. max slot count per task (cell-height pressure)
 *  3. Total unique participants assigned this day (overall density signal)
 *
 * Returns a value between 6 and 9 that keeps the layout compact.
 */
function chooseFontSize(dayTasks: Task[], schedule: Schedule): number {
  // Group tasks by type to measure density
  const tasksByType = new Map<string, Task[]>();
  for (const tk of dayTasks) {
    const key = tk.sourceName || tk.name;
    if (!tasksByType.has(key)) tasksByType.set(key, []);
    tasksByType.get(key)!.push(tk);
  }

  let maxRows = 0;
  let maxSlotsPerCell = 1;
  for (const [, tasks] of tasksByType) {
    if (tasks.length === 0) continue;
    maxRows = Math.max(maxRows, getUniqueStartTimes(tasks).length);
    for (const tk of tasks) {
      maxSlotsPerCell = Math.max(maxSlotsPerCell, tk.slots.length);
    }
  }

  const dayTaskIds = new Set(dayTasks.map((t) => t.id));
  const dayAssignments = schedule.assignments.filter((a) => dayTaskIds.has(a.taskId));
  const uniqueParticipants = new Set(dayAssignments.map((a) => a.participantId)).size;

  let size = 9;
  if (maxRows > 6 || uniqueParticipants > 30) size = Math.min(size, 8);
  if (maxRows > 8 || uniqueParticipants > 45 || maxSlotsPerCell > 4) size = Math.min(size, 7);
  if (maxRows > 10 || uniqueParticipants > 60) size = Math.min(size, 6);

  return size;
}

/**
 * Render a single day's schedule onto the current page using the smart
 * layout engine for spatial arrangement. Sections are packed into balanced
 * rows with proportional widths — the same algorithm as the on-screen grid.
 */
function renderDayPage(doc: jsPDF, schedule: Schedule, dayIndex: number, dayStartHour: number = 5): void {
  const { start } = getDayWindow(schedule, dayIndex, dayStartHour);
  const dayName = HEBREW_DAYS[start.getDay()];
  const numDays = getNumDays(schedule);

  const topY = drawTitle(doc, `יום ${dayName}`, `יום ${dayIndex} / ${numDays}`);

  const dayTasks = getTasksForDay(schedule, dayIndex, dayStartHour);
  if (dayTasks.length === 0) {
    doc.setFontSize(10);
    doc.setTextColor(150, 150, 150);
    doc.text(rtl('אין משימות ביום זה'), doc.internal.pageSize.getWidth() / 2, topY + 15, { align: 'center' });
    return;
  }

  const pageW = doc.internal.pageSize.getWidth();
  const fontSize = chooseFontSize(dayTasks, schedule);
  const { rows } = computeGridLayoutSmart(dayTasks, pageW, topY);

  // Render rows top-to-bottom; within each row, render sections side-by-side
  let currentY = topY;
  for (const rowRegions of rows) {
    let rowBottomY = currentY;
    for (const region of rowRegions) {
      region.y = currentY;
      const bottomY = renderSectionTablePdf(doc, region.tasks, schedule, region, fontSize);
      rowBottomY = Math.max(rowBottomY, bottomY);
    }
    currentY = rowBottomY + ROW_GAP;
  }
}

/**
 * Export a single day's schedule as a one-page A4 landscape PDF.
 */
export function exportDailyDetail(schedule: Schedule, dayIndex: number, dayStartHour: number = 5): void {
  const doc = createDoc();
  renderDayPage(doc, schedule, dayIndex, dayStartHour);
  doc.save(`daily-day${dayIndex}.pdf`);
}

// ─── Weekly Overview Export ──────────────────────────────────────────────────

/**
 * Export one page per day — all days in a single PDF file.
 */
export function exportWeeklyOverview(schedule: Schedule, dayStartHour: number = 5): void {
  const doc = createDoc();
  const numDays = getNumDays(schedule);

  for (let d = 1; d <= numDays; d++) {
    if (d > 1) doc.addPage();
    renderDayPage(doc, schedule, d, dayStartHour);
  }

  doc.save('schedule-overview.pdf');
}
