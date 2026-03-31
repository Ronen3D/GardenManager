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

import { jsPDF } from 'jspdf';
import autoTable, { type UserOptions, type CellDef } from 'jspdf-autotable';
import { RUBIK_FONT_BASE64 } from './utils/rubik-font-data';
import {
  Schedule,
  Task,
  AdanitTeam,
} from '../models/types';
import { getTaskAssignments, getUniqueStartTimes } from './schedule-grid-view';
import { TASK_COLORS, TASK_TYPE_LABELS } from './ui-helpers';
import { HEBREW_DAYS } from '../utils/date-utils';
import { addDays } from 'date-fns';

/** Resolve a task's display category, with fallback for un-migrated data. */
function getDisplayCategory(task: Task): string {
  if (task.displayCategory) return task.displayCategory;
  switch (task.type) {
    case 'Karov': case 'Karovit': case 'Adanit': return 'patrol';
    case 'Hamama': return 'hamama';
    case 'Aruga': return 'aruga';
    case 'Mamtera': return 'mamtera';
    case 'Shemesh': return 'shemesh';
    default: return (task.type || 'custom').toLowerCase();
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DAY_START_HOUR = 5;
const PAGE_MARGIN = 8;                // mm from each edge
const COL_GAP = 4;                    // mm between grid columns
const ROW_GAP = 3;                    // mm between grid rows
const TABLE_LABEL_OFFSET = 3;         // mm from label text to table top

/** Named Hebrew shift labels by start-hour ranges */
const SHIFT_NAMES: Record<number, string> = {
  5: 'בוקר', 6: 'בוקר', 7: 'בוקר', 8: 'בוקר',
  12: 'צהריים', 13: 'צהריים', 14: 'צהריים',
  17: 'ערב', 18: 'ערב', 19: 'ערב', 20: 'ערב', 21: 'לילה', 22: 'לילה', 23: 'לילה',
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
    const isNeutral = /[\s\-–—:;,.!?()\[\]{}\/\\#@'"]/.test(ch);
    if (current.length === 0) { currentIsHebrew = isHeb; current = ch; }
    else if (isNeutral) { current += ch; }
    else if (isHeb === currentIsHebrew) { current += ch; }
    else { segments.push({ text: current, isHebrew: currentIsHebrew }); current = ch; currentIsHebrew = isHeb; }
  }
  if (current) segments.push({ text: current, isHebrew: currentIsHebrew });

  return segments.map(s => s.isHebrew ? [...s.text].reverse().join('') : s.text).reverse().join('');
}

// ─── PDF helpers ─────────────────────────────────────────────────────────────

function createDoc(): jsPDF {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.addFileToVFS('Rubik-Regular.ttf', RUBIK_FONT_BASE64);
  doc.addFont('Rubik-Regular.ttf', 'Rubik', 'normal');
  doc.setFont('Rubik', 'normal');
  return doc;
}

function getDayWindow(schedule: Schedule, dayIndex: number): { start: Date; end: Date } {
  const allStarts = schedule.tasks.map(t => new Date(t.timeBlock.start).getTime());
  const scheduleStart = new Date(Math.min(...allStarts));
  const dayAnchor = addDays(scheduleStart, dayIndex - 1);
  const dayStart = new Date(dayAnchor);
  if (dayStart.getHours() < DAY_START_HOUR) dayStart.setDate(dayStart.getDate() - 1);
  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
  return { start: dayStart, end: addDays(dayStart, 1) };
}

function getTasksForDay(schedule: Schedule, dayIndex: number): Task[] {
  const { start, end } = getDayWindow(schedule, dayIndex);
  return schedule.tasks.filter(t => {
    const s = new Date(t.timeBlock.start).getTime();
    return s >= start.getTime() && s < end.getTime();
  });
}

function getNumDays(schedule: Schedule): number {
  const starts = schedule.tasks.map(t => new Date(t.timeBlock.start).getTime());
  const ends = schedule.tasks.map(t => new Date(t.timeBlock.end).getTime());
  return Math.ceil((Math.max(...ends) - Math.min(...starts)) / (24 * 3600_000));
}

function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  doc.setFontSize(16); doc.setTextColor(55, 65, 81);
  doc.text(rtl('ניהול גינה'), w / 2, 11, { align: 'center' });

  // Day subtitle right-aligned
  doc.setFontSize(9); doc.setTextColor(100, 100, 100);
  doc.text(rtl(dayTitle), w - PAGE_MARGIN, 18, { align: 'right' });

  doc.setFontSize(7); doc.setTextColor(150, 150, 150);
  doc.text(rtl(daySubtitle), w - PAGE_MARGIN, 22, { align: 'right' });

  doc.setDrawColor(200, 200, 200); doc.setLineWidth(0.3);
  doc.line(PAGE_MARGIN, 24, w - PAGE_MARGIN, 24);
  return 27;
}

/** Shared compact table defaults — positioned at (x, y) with a fixed width */
function tblDefaults(doc: jsPDF, y: number, fontSize = 7): Partial<UserOptions> {
  return {
    startY: y,
    theme: 'grid',
    styles: {
      font: 'Rubik', fontStyle: 'normal', fontSize,
      halign: 'right', cellPadding: { top: 1.8, bottom: 1.8, left: 1, right: 1 },
      lineColor: [210, 210, 210], lineWidth: 0.2,
      overflow: 'ellipsize',
    },
    headStyles: {
      fillColor: [55, 65, 81], textColor: [255, 255, 255],
      fontSize, halign: 'center', fontStyle: 'normal', cellPadding: 1.5,
    },
    margin: { right: PAGE_MARGIN, left: PAGE_MARGIN, top: PAGE_MARGIN, bottom: PAGE_MARGIN },
    didParseCell: (data: any) => { data.cell.styles.font = 'Rubik'; },
  };
}

// ─── Grid Layout Engine ──────────────────────────────────────────────────────

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

/**
 * Compute spatial layout regions mirroring the on-screen CSS grid:
 *
 *  RTL reading order (right = start):
 *  ┌────────────────────┬─────────────┐
 *  │  PATROL (right)    │  HAMAMA     │
 *  │  spans full height ├─────────────┤
 *  │  of right col      │  ARUGA      │
 *  ├────────────────────┴─────────────┤
 *  │  MAMTERA  │  SHEMESH (bottom)    │
 *  └───────────┴──────────────────────┘
 *
 * When a category has zero tasks, its slot is removed and neighbours expand.
 */
function computeGridLayout(
  dayTasks: Task[],
  pageW: number,
  topY: number,
): { upperRegions: GridRegion[]; lowerRegions: GridRegion[]; patrol: GridRegion | null } {
  const patrol = dayTasks.filter(t => getDisplayCategory(t) === 'patrol');
  const hamama = dayTasks.filter(t => getDisplayCategory(t) === 'hamama');
  const aruga = dayTasks.filter(t => getDisplayCategory(t) === 'aruga');
  const mamtera = dayTasks.filter(t => getDisplayCategory(t) === 'mamtera');
  const shemesh = dayTasks.filter(t => getDisplayCategory(t) === 'shemesh');

  const usable = pageW - 2 * PAGE_MARGIN;
  const hasPatrol = patrol.length > 0;
  const hasRight = hamama.length > 0 || aruga.length > 0; // right-side stacked column (left on page due to RTL PDF)

  // ── Upper area: Patrol (right / wider) + Hamama/Aruga stacked (left / narrower) ──
  let patrolW = 0;
  let rightColW = 0;

  if (hasPatrol && hasRight) {
    patrolW = Math.round(usable * 0.6);
    rightColW = usable - patrolW - COL_GAP;
  } else if (hasPatrol) {
    patrolW = usable;
  } else if (hasRight) {
    rightColW = usable;
  }

  // Patrol region — positioned at the RIGHT side of the page (high x in landscape)
  // Because jsPDF autoTable is LTR-positioned, right side = higher x
  const patrolRegion: GridRegion | null = hasPatrol ? {
    key: 'patrol', label: 'כרוב, כרובית ואדנית', tasks: patrol,
    color: '', x: pageW - PAGE_MARGIN - patrolW, y: topY, width: patrolW,
  } : null;

  // Stacked right regions (Hamama on top, Aruga below)
  const upperRegions: GridRegion[] = [];
  if (hamama.length > 0) {
    upperRegions.push({
      key: 'hamama', label: TASK_TYPE_LABELS.Hamama, tasks: hamama,
      color: TASK_COLORS.Hamama,
      x: PAGE_MARGIN, y: topY, width: rightColW,
    });
  }
  if (aruga.length > 0) {
    upperRegions.push({
      key: 'aruga', label: TASK_TYPE_LABELS.Aruga, tasks: aruga,
      color: TASK_COLORS.Aruga,
      x: PAGE_MARGIN, y: topY, width: rightColW, // y will be adjusted after hamama renders
    });
  }

  // ── Lower area: Mamtera + Shemesh side-by-side, full width ──
  const lowerCats: { key: string; label: string; tasks: Task[]; color: string }[] = [];
  if (shemesh.length > 0) lowerCats.push({ key: 'shemesh', label: TASK_TYPE_LABELS.Shemesh, tasks: shemesh, color: TASK_COLORS.Shemesh });
  if (mamtera.length > 0) lowerCats.push({ key: 'mamtera', label: TASK_TYPE_LABELS.Mamtera, tasks: mamtera, color: TASK_COLORS.Mamtera });

  const lowerRegions: GridRegion[] = [];
  if (lowerCats.length > 0) {
    const catW = lowerCats.length > 1
      ? (usable - COL_GAP * (lowerCats.length - 1)) / lowerCats.length
      : usable;
    // Place from right to left (RTL)
    let xCursor = pageW - PAGE_MARGIN;
    for (const cat of lowerCats) {
      xCursor -= catW;
      lowerRegions.push({
        key: cat.key, label: cat.label, tasks: cat.tasks,
        color: cat.color, x: xCursor, y: 0, width: catW, // y set later
      });
      xCursor -= COL_GAP;
    }
  }

  return { upperRegions, lowerRegions, patrol: patrolRegion };
}

// ─── Table Renderers ─────────────────────────────────────────────────────────

/**
 * Render the Patrol table (Karov + Karovit + Adanit combined) at a given
 * position. Dynamically builds columns based on which sub-types are present.
 * Returns the finalY after the table.
 */
function renderPatrolTable(
  doc: jsPDF, tasks: Task[], schedule: Schedule,
  region: GridRegion, fontSize: number,
): number {
  // Split: tasks with adanitTeam slots vs. regular (per-type) columns
  const teamTasks = tasks.filter(t => t.slots.some(s => s.adanitTeam != null));
  const nonTeamTasks = tasks.filter(t => !t.slots.some(s => s.adanitTeam != null));
  const nonTeamByType = new Map<string, Task[]>();
  for (const t of nonTeamTasks) {
    const key = t.type as string;
    if (!nonTeamByType.has(key)) nonTeamByType.set(key, []);
    nonTeamByType.get(key)!.push(t);
  }
  const uniqueTimes = getUniqueStartTimes(tasks);

  // Section label
  doc.setFontSize(fontSize); doc.setTextColor(80, 80, 80);
  doc.text(rtl(region.label), region.x + region.width - 1, region.y, { align: 'right' });
  const tableY = region.y + TABLE_LABEL_OFFSET;

  // ── Dynamic columns (RTL order: data cols left-to-right, Time rightmost) ──
  type ColDef = { header: string; build: (timeNum: number) => { content: string; colorKey: string } };
  const columns: ColDef[] = [];

  // Non-team type columns (e.g. Karovit, Karov, or any custom patrol type)
  for (const [typeKey, typeTasks] of nonTeamByType) {
    columns.push({
      header: (TASK_TYPE_LABELS as Record<string, string>)[typeKey] || typeKey,
      build: (timeNum) => {
        const atTime = typeTasks.filter(tk => new Date(tk.timeBlock.start).getTime() === timeNum);
        const names = atTime.flatMap(tk => getTaskAssignments(tk, schedule)
          .filter(s => s.participant).map(s => rtl(s.participant!.name))).join('\n\n');
        return { content: names || '—', colorKey: typeKey };
      },
    });
  }

  // Team-based columns (slots with adanitTeam designation)
  if (teamTasks.length > 0) {
    const allTeamSlots = teamTasks.flatMap(tk => tk.slots);
    const hasSecondary = allTeamSlots.some(s => s.adanitTeam === AdanitTeam.SegolSecondary);
    const hasMain = allTeamSlots.some(s => s.adanitTeam === AdanitTeam.SegolMain);

    if (hasSecondary) {
      columns.push({
        header: 'סגול משני',
        build: (timeNum) => {
          const atTime = teamTasks.filter(tk => new Date(tk.timeBlock.start).getTime() === timeNum);
          const names = atTime.flatMap(tk => getTaskAssignments(tk, schedule)
            .filter(s => s.slot.adanitTeam === AdanitTeam.SegolSecondary && s.participant)
            .map(s => rtl(s.participant!.name))).join('\n\n');
          const colorKey = atTime[0]?.type as string || 'Adanit';
          return { content: names || '—', colorKey };
        },
      });
    }

    if (hasMain) {
      columns.push({
        header: 'סגול ראשי',
        build: (timeNum) => {
          const atTime = teamTasks.filter(tk => new Date(tk.timeBlock.start).getTime() === timeNum);
          const names = atTime.flatMap(tk => getTaskAssignments(tk, schedule)
            .filter(s => s.slot.adanitTeam === AdanitTeam.SegolMain && s.participant)
            .map(s => rtl(s.participant!.name))).join('\n\n');
          const colorKey = atTime[0]?.type as string || 'Adanit';
          return { content: names || '—', colorKey };
        },
      });
    }
  }

  // Time column is always last (rightmost in the RTL table)
  const head: CellDef[] = [
    ...columns.map(c => ({ content: rtl(c.header), styles: { halign: 'center' as const } })),
    { content: rtl('זמן'), styles: { halign: 'center' as const } },
  ];

  const emptyStyle = { halign: 'center' as const, textColor: [190, 190, 190] as [number, number, number] };
  const filledStyle = (colorKey: string) => ({
    halign: 'center' as const,
    fillColor: tint(TASK_COLORS[colorKey] || '#ecf0f1') as [number, number, number],
  });

  const body: CellDef[][] = uniqueTimes.map(timeNum => {
    const time = new Date(timeNum);
    const cells: CellDef[] = columns.map(col => {
      const { content, colorKey } = col.build(timeNum);
      return { content, styles: content === '—' ? emptyStyle : filledStyle(colorKey) };
    });
    cells.push({ content: fmtTime(time), styles: { halign: 'center' as const } });
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

/**
 * Render a generic category table (Hamama, Aruga, Mamtera, Shemesh, or any
 * future task type) at a given position. Columns are derived dynamically
 * from the number of slots in the tasks.
 * Returns the finalY after the table.
 */
function renderCategoryTable(
  doc: jsPDF, tasks: Task[], schedule: Schedule,
  region: GridRegion, fontSize: number,
): number {
  // Section label
  doc.setFontSize(fontSize); doc.setTextColor(80, 80, 80);
  doc.text(rtl(region.label), region.x + region.width - 1, region.y, { align: 'right' });
  const tableY = region.y + TABLE_LABEL_OFFSET;

  const uniqueTimes = getUniqueStartTimes(tasks);
  const totalShifts = uniqueTimes.length;

  // Determine how many slot columns this category needs
  const maxSlots = Math.max(...tasks.map(t => t.slots.length), 1);

  // Build header — for 1 slot use the category name, for N slots: "#N | ... | #1"
  // Column order: data columns (high # to low #) then Time (rightmost)
  const head: CellDef[] = [];
  if (maxSlots > 1) {
    for (let i = maxSlots; i >= 1; i--) {
      const slotLabel = `${region.label} #${i}`;
      head.push({ content: rtl(slotLabel), styles: { halign: 'center' as const } });
    }
  } else {
    head.push({ content: rtl(region.label), styles: { halign: 'center' as const } });
  }
  head.push({ content: rtl('זמן'), styles: { halign: 'center' as const } });

  const emptyStyle = { halign: 'center' as const, textColor: [190, 190, 190] as [number, number, number] };
  const filledStyle = { halign: 'center' as const, fillColor: tint(region.color) as [number, number, number] };

  const body: CellDef[][] = uniqueTimes.map(timeNum => {
    const time = new Date(timeNum);
    const atTime = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
    const allAssigned = atTime.flatMap(t => getTaskAssignments(t, schedule));

    const row: CellDef[] = [];
    if (maxSlots > 1) {
      // Reverse slot order to match on-screen (#N left → #1 right)
      for (let i = maxSlots - 1; i >= 0; i--) {
        const s = allAssigned[i];
        const name = s?.participant ? rtl(s.participant.name) : '—';
        row.push({ content: name, styles: name === '—' ? emptyStyle : filledStyle });
      }
    } else {
      const names = allAssigned.filter(s => s.participant).map(s => rtl(s.participant!.name)).join('\n\n') || '—';
      row.push({ content: names, styles: names === '—' ? emptyStyle : filledStyle });
    }
    row.push({ content: fmtTimeLabel(time, totalShifts), styles: { halign: 'center' as const } });
    return row;
  });

  // Column widths: time col = 14mm, data cols share the rest
  const timeW = 14;
  const slotW = (region.width - timeW) / maxSlots;
  const colStyles: Record<number, Partial<{ cellWidth: number }>> = {};
  for (let i = 0; i < maxSlots; i++) colStyles[i] = { cellWidth: slotW };
  colStyles[maxSlots] = { cellWidth: timeW };

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
    const key = tk.type as string;
    if (!tasksByType.has(key)) tasksByType.set(key, []);
    tasksByType.get(key)!.push(tk);
  }

  let maxRows = 0;
  let maxSlotsPerCell = 1;
  for (const [, tasks] of tasksByType) {
    if (tasks.length === 0) continue;
    maxRows = Math.max(maxRows, getUniqueStartTimes(tasks).length);
    // For merged-slot columns (e.g. Karov with 4 slots shown in one cell),
    // count the most names that can land in a single column.
    for (const tk of tasks) {
      maxSlotsPerCell = Math.max(maxSlotsPerCell, tk.slots.length);
    }
  }

  // Count unique participants assigned today
  const dayTaskIds = new Set(dayTasks.map(t => t.id));
  const dayAssignments = schedule.assignments.filter(a => dayTaskIds.has(a.taskId));
  const uniqueParticipants = new Set(dayAssignments.map(a => a.participantId)).size;

  // Base size: start generous, then reduce for density
  // Few rows + few people → 9pt;  moderate → 8pt;  dense → 7pt;  very dense → 6pt
  let size = 9;

  if (maxRows > 6 || uniqueParticipants > 30) size = Math.min(size, 8);
  if (maxRows > 8 || uniqueParticipants > 45 || maxSlotsPerCell > 4) size = Math.min(size, 7);
  if (maxRows > 10 || uniqueParticipants > 60) size = Math.min(size, 6);

  return size;
}

/**
 * Render a single day's schedule onto the current page of `doc` using
 * the spatial grid layout that mirrors the on-screen CSS grid.
 * Used by both single-day export and the weekly multi-page export.
 */
function renderDayPage(doc: jsPDF, schedule: Schedule, dayIndex: number): void {
  const { start } = getDayWindow(schedule, dayIndex);
  const dayName = HEBREW_DAYS[start.getDay()];
  const numDays = getNumDays(schedule);

  const topY = drawTitle(
    doc,
    `יום ${dayName}`,
    `יום ${dayIndex} / ${numDays}`,
  );

  const dayTasks = getTasksForDay(schedule, dayIndex);
  if (dayTasks.length === 0) {
    doc.setFontSize(10); doc.setTextColor(150, 150, 150);
    doc.text(rtl('אין משימות ביום זה'), doc.internal.pageSize.getWidth() / 2, topY + 15, { align: 'center' });
    return;
  }

  const pageW = doc.internal.pageSize.getWidth();
  const fontSize = chooseFontSize(dayTasks, schedule);
  const { upperRegions, lowerRegions, patrol } = computeGridLayout(dayTasks, pageW, topY);

  // ── Render upper-right: Patrol ──
  let patrolBottomY = topY;
  if (patrol) {
    patrolBottomY = renderPatrolTable(doc, patrol.tasks, schedule, patrol, fontSize);
  }

  // ── Render upper-left: Hamama then Aruga (stacked) ──
  let leftBottomY = topY;
  for (const region of upperRegions) {
    region.y = leftBottomY;
    leftBottomY = renderCategoryTable(doc, region.tasks, schedule, region, fontSize);
    leftBottomY += ROW_GAP;
  }

  // ── Render lower row: Mamtera + Shemesh side-by-side (full width) ──
  const lowerTopY = Math.max(patrolBottomY, leftBottomY) + ROW_GAP;
  for (const region of lowerRegions) {
    region.y = lowerTopY;
    renderCategoryTable(doc, region.tasks, schedule, region, fontSize);
  }
}

/**
 * Export a single day's schedule as a one-page A4 landscape PDF.
 */
export function exportDailyDetail(schedule: Schedule, dayIndex: number): void {
  const doc = createDoc();
  renderDayPage(doc, schedule, dayIndex);
  doc.save(`daily-day${dayIndex}.pdf`);
}

// ─── Weekly Overview Export ──────────────────────────────────────────────────

/**
 * Export one page per day — all days in a single PDF file.
 */
export function exportWeeklyOverview(schedule: Schedule): void {
  const doc = createDoc();
  const numDays = getNumDays(schedule);

  for (let d = 1; d <= numDays; d++) {
    if (d > 1) doc.addPage();
    renderDayPage(doc, schedule, d);
  }

  doc.save('schedule-overview.pdf');
}
