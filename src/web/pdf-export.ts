/**
 * Professional PDF Export — Hebrew / RTL Support
 *
 * Two export modes, each designed to fit on a single A4 landscape page:
 *   1. Weekly Overview  — participant × day matrix with task-type names only
 *   2. Daily Detail     — compact per-category tables mirroring the on-screen grid
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
  TaskType,
  Level,
  AdanitTeam,
} from '../models/types';
import { getTaskAssignments, getUniqueStartTimes } from './schedule-grid-view';
import { TASK_COLORS, TASK_TYPE_LABELS } from './ui-helpers';
import { addDays } from 'date-fns';

// ─── Constants ───────────────────────────────────────────────────────────────

const DAY_START_HOUR = 5;

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

function fmtDateShort(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function drawTitle(doc: jsPDF, title: string, subtitle: string): number {
  const w = doc.internal.pageSize.getWidth();
  doc.setFontSize(14); doc.setTextColor(55, 65, 81);
  doc.text(rtl(title), w - 8, 11, { align: 'right' });
  doc.setFontSize(8); doc.setTextColor(130, 130, 130);
  doc.text(rtl(subtitle), w - 8, 16, { align: 'right' });
  doc.setDrawColor(200, 200, 200); doc.setLineWidth(0.3);
  doc.line(8, 18, w - 8, 18);
  return 21;
}

/** Shared compact table defaults */
function tblDefaults(doc: jsPDF, y: number): Partial<UserOptions> {
  return {
    startY: y,
    theme: 'grid',
    styles: {
      font: 'Rubik', fontStyle: 'normal', fontSize: 7,
      halign: 'right', cellPadding: { top: 2, bottom: 2, left: 1.2, right: 1.2 },
      lineColor: [210, 210, 210], lineWidth: 0.2,
      overflow: 'ellipsize',
    },
    headStyles: {
      fillColor: [55, 65, 81], textColor: [255, 255, 255],
      fontSize: 7, halign: 'center', fontStyle: 'normal', cellPadding: 1.5,
    },
    margin: { right: 8, left: 8, top: 8, bottom: 8 },
    didParseCell: (data: any) => { data.cell.styles.font = 'Rubik'; },
  };
}

// ─── Daily Detail Export ─────────────────────────────────────────────────────

/**
 * Render a single day's schedule onto the current page of `doc`.
 * Used by both single-day export and the weekly multi-page export.
 */
function renderDayPage(doc: jsPDF, schedule: Schedule, dayIndex: number): void {
  const { start } = getDayWindow(schedule, dayIndex);
  const dayName = HEBREW_DAYS[start.getDay()];
  const numDays = getNumDays(schedule);

  let y = drawTitle(
    doc,
    `יום ${dayName} ${fmtDateShort(start)}`,
    `יום ${dayIndex} / ${numDays}`,
  );

  const dayTasks = getTasksForDay(schedule, dayIndex);
  if (dayTasks.length === 0) {
    doc.setFontSize(10); doc.setTextColor(150, 150, 150);
    doc.text(rtl('אין משימות ביום זה'), doc.internal.pageSize.getWidth() / 2, y + 15, { align: 'center' });
    return;
  }

  // ── Patrol / Adanit table ──
  const patrolTasks = dayTasks.filter(t =>
    t.type === TaskType.Karov || t.type === TaskType.Karovit || t.type === TaskType.Adanit
  );
  if (patrolTasks.length > 0) {
    y = renderPatrolTable(doc, patrolTasks, schedule, y);
  }

  // ── Side-by-side small tables: Hamama | Aruga | Shemesh | Mamtera ──
  const hamama = dayTasks.filter(t => t.type === TaskType.Hamama);
  const aruga = dayTasks.filter(t => t.type === TaskType.Aruga);
  const shemesh = dayTasks.filter(t => t.type === TaskType.Shemesh);
  const mamtera = dayTasks.filter(t => t.type === TaskType.Mamtera);

  const smallCategories: { label: string; tasks: Task[]; color: string }[] = [
    { label: 'חממה', tasks: hamama, color: TASK_COLORS.Hamama },
    { label: 'ערוגה', tasks: aruga, color: TASK_COLORS.Aruga },
    { label: 'שמש', tasks: shemesh, color: TASK_COLORS.Shemesh },
    { label: 'ממטרה', tasks: mamtera, color: TASK_COLORS.Mamtera },
  ].filter(c => c.tasks.length > 0);

  if (smallCategories.length > 0) {
    y += 2;
    // Lay them out left-to-right, each as a narrow autoTable
    const pageW = doc.internal.pageSize.getWidth();
    const usable = pageW - 16; // margins
    const gap = 4;
    const catW = (usable - gap * (smallCategories.length - 1)) / smallCategories.length;
    let xOffset = 8; // start from left margin

    for (const cat of smallCategories) {
      renderSmallCategoryTable(doc, cat.tasks, schedule, cat.label, cat.color, y, xOffset, catW);
      xOffset += catW + gap;
    }

    // Advance y past the tallest table
    const endYs = smallCategories.map(() => {
      try { return (doc as any).lastAutoTable?.finalY ?? y; } catch { return y; }
    });
    y = Math.max(...endYs, y + 20);
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

  doc.save('weekly-overview.pdf');
}
function renderPatrolTable(doc: jsPDF, tasks: Task[], schedule: Schedule, startY: number): number {
  const karovit = tasks.filter(t => t.type === TaskType.Karovit);
  const karov = tasks.filter(t => t.type === TaskType.Karov);
  const adanit = tasks.filter(t => t.type === TaskType.Adanit);
  const uniqueTimes = getUniqueStartTimes(tasks);

  // Section label
  doc.setFontSize(8); doc.setTextColor(80, 80, 80);
  doc.text(rtl('כרוב, כרובית ואדנית'), doc.internal.pageSize.getWidth() - 8, startY, { align: 'right' });
  startY += 3;

  // Columns RTL: כרובית | כרוב | סגול משני | סגול ראשי | משמרת
  const head: CellDef[] = [
    rtl('כרובית'), rtl('כרוב'), rtl('סגול משני'), rtl('סגול ראשי'), rtl('משמרת'),
  ].map(c => ({ content: c, styles: { halign: 'center' as const } }));

  const body: CellDef[][] = uniqueTimes.map(timeNum => {
    const time = new Date(timeNum);
    const timeLabel = fmtTime(time);

    const getName = (t: Task[]): string => {
      const atTime = t.filter(tk => new Date(tk.timeBlock.start).getTime() === timeNum);
      return atTime.flatMap(tk => getTaskAssignments(tk, schedule)
        .filter(s => s.participant)
        .map(s => rtl(s.participant!.name))
      ).join('\n\n') || '—';
    };

    // Adanit split by team
    const adanitAtTime = adanit.filter(tk => new Date(tk.timeBlock.start).getTime() === timeNum);
    let segolMain = '—';
    let segolSec = '—';
    if (adanitAtTime.length > 0) {
      const allSlots = adanitAtTime.flatMap(tk => getTaskAssignments(tk, schedule));
      const mainNames = allSlots.filter(s => s.slot.adanitTeam === AdanitTeam.SegolMain && s.participant)
        .map(s => rtl(s.participant!.name));
      const secNames = allSlots.filter(s => s.slot.adanitTeam === AdanitTeam.SegolSecondary && s.participant)
        .map(s => rtl(s.participant!.name));
      if (mainNames.length) segolMain = mainNames.join('\n\n');
      if (secNames.length) segolSec = secNames.join('\n\n');
    }

    const emptyStyle = { halign: 'center' as const, textColor: [190, 190, 190] as [number, number, number] };
    const filledStyle = (type: string) => ({
      halign: 'center' as const,
      fillColor: tint(TASK_COLORS[type] || '#ecf0f1') as [number, number, number],
    });

    const karovitNames = getName(karovit);
    const karovNames = getName(karov);

    return [
      { content: karovitNames, styles: karovitNames === '—' ? emptyStyle : filledStyle('Karovit') },
      { content: karovNames, styles: karovNames === '—' ? emptyStyle : filledStyle('Karov') },
      { content: segolSec, styles: segolSec === '—' ? emptyStyle : filledStyle('Adanit') },
      { content: segolMain, styles: segolMain === '—' ? emptyStyle : filledStyle('Adanit') },
      { content: timeLabel, styles: { halign: 'center' as const } },
    ];
  });

  autoTable(doc, { ...tblDefaults(doc, startY), head: [head], body });
  return (doc as any).lastAutoTable.finalY + 3;
}

/** Render a small single-category table (Hamama, Aruga, Shemesh, Mamtera)
 *  at a specific x-offset with a fixed width. Columns: shift | names */
function renderSmallCategoryTable(
  doc: jsPDF, tasks: Task[], schedule: Schedule,
  label: string, color: string,
  startY: number, x: number, width: number,
): void {
  // Label
  doc.setFontSize(7); doc.setTextColor(80, 80, 80);
  doc.text(rtl(label), x + width - 1, startY, { align: 'right' });
  const tableY = startY + 3;

  const uniqueTimes = getUniqueStartTimes(tasks);

  // Determine how many slot columns this category needs
  const maxSlots = Math.max(...tasks.map(t => t.slots.length), 1);

  // Build header — for 1 slot just "שם", for 2 slots "#2 | #1"
  const head: CellDef[] = [];
  if (maxSlots > 1) {
    for (let i = maxSlots; i >= 1; i--) head.push({ content: `#${i}`, styles: { halign: 'center' as const } });
  } else {
    head.push({ content: rtl('שם'), styles: { halign: 'center' as const } });
  }
  head.push({ content: rtl('משמרת'), styles: { halign: 'center' as const } });

  const body: CellDef[][] = uniqueTimes.map(timeNum => {
    const time = new Date(timeNum);
    const atTime = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
    const allAssigned = atTime.flatMap(t => getTaskAssignments(t, schedule));

    const emptyStyle = { halign: 'center' as const, textColor: [190, 190, 190] as [number, number, number] };
    const filledStyle = { halign: 'center' as const, fillColor: tint(color) as [number, number, number] };

    const row: CellDef[] = [];
    if (maxSlots > 1) {
      // Reverse slot order to match on-screen (#2 left, #1 right)
      for (let i = maxSlots - 1; i >= 0; i--) {
        const s = allAssigned[i];
        const name = s?.participant ? rtl(s.participant.name) : '—';
        row.push({ content: name, styles: name === '—' ? emptyStyle : filledStyle });
      }
    } else {
      const names = allAssigned.filter(s => s.participant).map(s => rtl(s.participant!.name)).join('\n\n') || '—';
      row.push({ content: names, styles: names === '—' ? emptyStyle : filledStyle });
    }
    row.push({ content: fmtTime(time), styles: { halign: 'center' as const } });
    return row;
  });

  // Distribute column widths: shift time = 14mm, rest evenly split
  const shiftW = 14;
  const slotW = (width - shiftW) / maxSlots;
  const colStyles: Record<number, Partial<{ cellWidth: number }>> = {};
  for (let i = 0; i < maxSlots; i++) colStyles[i] = { cellWidth: slotW };
  colStyles[maxSlots] = { cellWidth: shiftW };

  autoTable(doc, {
    ...tblDefaults(doc, tableY),
    head: [head],
    body,
    tableWidth: width,
    margin: { left: x, right: doc.internal.pageSize.getWidth() - x - width },
    columnStyles: colStyles,
  });
}
