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
import autoTable, { __createTable, __drawTable, type CellDef, type UserOptions } from 'jspdf-autotable';
import type { Schedule, Task } from '../models/types';
import { fmtTime } from '../utils/date-utils';
import { triggerShareOrDownload } from './data-transfer';
import { buildDay0Schedule } from './day0-adapter';
import { getNumDays, getTasksForDay, tint } from './export-utils';
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

/**
 * Resolve a task's structural section key. Mirrors `getSectionKey` in
 * `layout-engine.ts` so PDF section grouping matches the on-screen grid.
 */
function getDisplayCategory(task: Task): string {
  return task.sectionKey || task.sourceName || task.name || 'custom';
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_MARGIN = 8; // mm from each edge
const COL_GAP = 4; // mm between grid columns
const ROW_GAP = 3; // mm between grid rows
const TABLE_LABEL_OFFSET = 3; // mm from label text to table top

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
    cells.push({ content: fmtTime(time), styles: { halign: 'center' as const } });
    return cells;
  });

  // Column widths: time col = 14mm, data cols share the rest
  const timeW = 14;
  const dataColW = columns.length > 0 ? (region.width - timeW) / columns.length : region.width - timeW;
  const colStyles: Record<number, Partial<{ cellWidth: number }>> = {};
  for (let i = 0; i < columns.length; i++) colStyles[i] = { cellWidth: dataColW };
  colStyles[columns.length] = { cellWidth: timeW };

  const tableOpts = {
    ...tblDefaults(doc, tableY, fontSize),
    head: [head],
    body,
    tableWidth: region.width,
    margin: { left: region.x, right: doc.internal.pageSize.getWidth() - region.x - region.width },
    columnStyles: colStyles,
  };
  const table = __createTable(doc, tableOpts);
  __drawTable(doc, table);

  return table.finalY ?? tableY;
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
  // Day 0 (continuity context): mark the title clearly so the printed page
  // can never be confused with a generated day. The schedule passed in for
  // d=0 is the synthetic Day-0 Schedule built from the continuity snapshot.
  const isDay0 = dayIndex === 0;
  const numDays = isDay0 ? schedule.periodDays : getNumDays(schedule, dayStartHour);

  const titleMain = isDay0 ? 'יום 0 — הקשר' : `יום ${dayIndex}`;
  const titleSub = isDay0 ? 'מהשבצ"ק הקודם · קריאה בלבד' : `מתוך ${numDays}`;
  const topY = drawTitle(doc, titleMain, titleSub);

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

interface BuiltDailyDoc {
  doc: jsPDF;
  /** Filename stem (no extension): `daily-day{N}` or `daily-day0-context`. */
  stem: string;
}

/**
 * Build the one-page A4 landscape jsPDF document for a single day. This is the
 * shared core of both the PDF and image single-day exports — keeping a single
 * code path guarantees the image is pixel-identical to the PDF.
 *
 * dayIndex=0 renders the continuity context (read-only) from the continuity
 * snapshot. When dayIndex=0 is passed but no continuity is attached, falls back
 * to day 1 (mirrors the long-standing PDF behaviour).
 */
function buildDailyDoc(schedule: Schedule, dayIndex: number, dayStartHour: number): BuiltDailyDoc {
  const doc = createDoc();
  if (dayIndex === 0) {
    const day0 = buildDay0Schedule(schedule);
    if (day0) {
      renderDayPage(doc, day0, 0, dayStartHour);
      return { doc, stem: 'daily-day0-context' };
    }
    dayIndex = 1;
  }
  renderDayPage(doc, schedule, dayIndex, dayStartHour);
  return { doc, stem: `daily-day${dayIndex}` };
}

/**
 * Export a single day's schedule as a one-page A4 landscape PDF.
 *
 * dayIndex=0 renders the continuity context (read-only) rendered from
 * `schedule.continuitySnapshot`. The header is tagged accordingly. When
 * dayIndex=0 is passed but no continuity is attached, falls back to day 1.
 */
export function exportDailyDetail(schedule: Schedule, dayIndex: number, dayStartHour: number = 5): void {
  const { doc, stem } = buildDailyDoc(schedule, dayIndex, dayStartHour);
  doc.save(`${stem}.pdf`);
}

// ─── Single-Day Image Export ─────────────────────────────────────────────────

/**
 * Target pixel width of the rasterised landscape-A4 page (~150 dpi). Tuned for
 * crisp Hebrew text on a phone and after WhatsApp re-encoding while keeping the
 * file small. Single named constant — see plan Gate 3.
 */
const RASTER_TARGET_PX = 2200;

/** Lazily-loaded pdf.js module + one-time inline-worker setup. */
let _pdfWorkerReady = false;
async function loadPdfjs() {
  // Dynamic import keeps pdf.js (~1.4 MB) out of the main bundle — fetched only
  // on first image export.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  if (!_pdfWorkerReady) {
    // `?worker&inline` base64-embeds the worker into the lazy pdf chunk and
    // runs it as a same-origin blob: worker — no separate file / URL
    // resolution, so it works in Vite dev, the GitHub Pages sub-path build,
    // and packaged Electron (file://, offline) alike.
    const PdfWorker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline')).default;
    pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
    _pdfWorkerReady = true;
  }
  return pdfjs;
}

/** Rasterise page 1 of a PDF blob to an opaque-white PNG blob. */
async function rasterizeFirstPageToPng(pdfBlob: Blob): Promise<Blob> {
  const data = new Uint8Array(await pdfBlob.arrayBuffer());
  const pdfjs = await loadPdfjs();
  // Embedded Rubik font + no CID/standard fonts ⇒ no cMap/standardFont assets
  // needed ⇒ fully offline / file:// safe.
  const pdf = await pdfjs.getDocument({ data }).promise;
  try {
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: RASTER_TARGET_PX / baseViewport.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    // PDF pages have no background — fill white so the PNG is opaque (no
    // transparent halo in chat thumbnails).
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), 'image/png'),
    );
  } finally {
    pdf.cleanup();
    await pdf.destroy();
  }
}

/**
 * Export a single day's schedule as a PNG image — the same visual output as
 * {@link exportDailyDetail}, rasterised from the very same jsPDF document. On
 * mobile this opens the native share sheet (WhatsApp etc.) via
 * `triggerShareOrDownload`, falling back to a named download elsewhere.
 *
 * Single-day only; the weekly overview never offers this.
 */
export async function exportDailyImage(schedule: Schedule, dayIndex: number, dayStartHour: number = 5): Promise<void> {
  const { doc, stem } = buildDailyDoc(schedule, dayIndex, dayStartHour);
  const png = await rasterizeFirstPageToPng(doc.output('blob'));
  await triggerShareOrDownload(png, `${stem}.png`, 'image/png');
}

// ─── Weekly Overview Export ──────────────────────────────────────────────────

/**
 * Export one page per day — all days in a single PDF file.
 *
 * When `includeDay0` is true and the schedule has continuity context, a
 * Day 0 page is prepended (rendered from the continuity snapshot, marked
 * as read-only context).
 */
export function exportWeeklyOverview(schedule: Schedule, dayStartHour: number = 5, includeDay0: boolean = true): void {
  const doc = createDoc();
  const numDays = getNumDays(schedule, dayStartHour);
  const day0 = includeDay0 ? buildDay0Schedule(schedule) : null;
  let needsAddPage = false;

  if (day0) {
    renderDayPage(doc, day0, 0, dayStartHour);
    needsAddPage = true;
  }

  for (let d = 1; d <= numDays; d++) {
    if (needsAddPage) doc.addPage();
    renderDayPage(doc, schedule, d, dayStartHour);
    needsAddPage = true;
  }

  doc.save('schedule-overview.pdf');
}
