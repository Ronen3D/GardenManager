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
 * schedule data. A single day is guaranteed to fit on ONE A4-landscape page:
 * `src/shared/pdf-fit-planner.ts` decides — before anything is drawn — how many
 * "name sub-columns" each section splits into, the font size and the cell
 * padding, so a dense day (one task with many people per cell) collapses to a
 * single page instead of spilling onto 3–4. Only a genuinely degenerate day
 * (more time-rows than physically fit at the floor config) breaks across pages,
 * and then only at whole layout-row boundaries.
 *
 * Uses jsPDF + jsPDF-AutoTable with an embedded Rubik TTF font for
 * correct Hebrew (Right-to-Left) rendering.
 */

import { jsPDF } from 'jspdf';
import { __createTable, __drawTable, type CellDef, type UserOptions } from 'jspdf-autotable';
import type { Schedule, Task } from '../models/types';
import {
  DEFAULT_LEVERS,
  type InitialPlacement,
  type PageGeometry,
  planDayLayout,
  type SectionDescriptor,
} from '../shared/pdf-fit-planner';
import { fmtTime } from '../utils/date-utils';
import { triggerShareOrDownload } from './data-transfer';
import { buildDay0Schedule } from './day0-adapter';
import { getTasksForDay, tint } from './export-utils';
import {
  assignRows,
  computeSectionMetrics,
  generateGridTemplate,
  getTaskAssignments,
  getUniqueStartTimes,
  type SectionMetrics,
} from './layout-engine';
import { RUBIK_FONT_BASE64 } from './utils/rubik-font-data';

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_MARGIN = 8; // mm from each edge
const COL_GAP = 4; // mm between grid columns
const ROW_GAP = 3; // mm between grid rows
const TABLE_LABEL_OFFSET = 3; // mm from label text to table top
const TIME_COL_W = 14; // mm — width of the rightmost time column
const MIN_NAME_COL_W = 20; // mm — min readable width for one name sub-column
const HEAD_PADDING = 1.5; // mm — per-side header cell padding (matches planner)
const GRID_UNITS = 12; // matches layout-engine GRID_UNITS

// ─── Hebrew RTL helper ───────────────────────────────────────────────────────

function rtl(text: string): string {
  if (!text) return text;
  const hebrewRange = /[֐-׿יִ-ﭏ]/;
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
function tblDefaults(y: number, fontSize = 7, cellPadding = 1.8): Partial<UserOptions> {
  return {
    startY: y,
    theme: 'grid',
    styles: {
      font: 'Rubik',
      fontStyle: 'normal',
      fontSize,
      halign: 'right',
      cellPadding: { top: cellPadding, bottom: cellPadding, left: 1, right: 1 },
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
      cellPadding: HEAD_PADDING,
    },
    margin: { right: PAGE_MARGIN, left: PAGE_MARGIN, top: PAGE_MARGIN, bottom: PAGE_MARGIN },
    didParseCell: (data: any) => {
      data.cell.styles.font = 'Rubik';
    },
  };
}

// ─── Logical Columns (single source of truth for structure + names) ──────────

/**
 * A logical strategy column for a section. The same definitions feed both the
 * fit planner (via name *counts*) and the renderer (via name *lists*), so the
 * predicted geometry always matches what is drawn.
 */
interface LogicalColumn {
  header: string;
  /** rtl-shaped participant names assigned in this column at `timeNum`. */
  namesAt: (timeNum: number) => string[];
  /** Representative tint colour for this column's cell at `timeNum`. */
  colorAt: (timeNum: number) => string;
}

/**
 * Resolve a section's logical columns. Mirrors the on-screen layout-engine
 * column strategy (multi-source split / sub-team / flat) but returns name
 * arrays rather than pre-joined strings so the renderer can re-shape them into
 * multiple name sub-columns.
 */
function buildLogicalColumns(section: SectionMetrics, schedule: Schedule): LogicalColumn[] {
  const tasks = section.tasks;
  const hasTeams = tasks.some((t) => t.slots.some((s) => s.subTeamId != null));
  const hasMultipleSources = new Set(tasks.map((t) => t.sourceName || t.name)).size > 1;
  const hasSubTeams = tasks.some((t) => t.slots.some((s) => s.subTeamId));
  const columns: LogicalColumn[] = [];

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

    for (const [sourceKey, sourceTasks] of nonTeamBySource) {
      columns.push({
        header: sourceKey,
        namesAt: (timeNum) => {
          const atTime = sourceTasks.filter((tk) => new Date(tk.timeBlock.start).getTime() === timeNum);
          return atTime.flatMap((tk) =>
            getTaskAssignments(tk, schedule)
              .filter((s) => s.participant)
              .map((s) => rtl(s.participant!.name)),
          );
        },
        colorAt: (timeNum) =>
          tasks.find((tk) => new Date(tk.timeBlock.start).getTime() === timeNum)?.color || '#7f8c8d',
      });
    }

    const allTeamSlots = teamTasks.flatMap((tk) => tk.slots);
    const distinctTeamIds = [...new Set(allTeamSlots.map((s) => s.subTeamId).filter(Boolean))] as string[];
    distinctTeamIds.sort();

    for (const teamId of distinctTeamIds) {
      const label = allTeamSlots.find((s) => s.subTeamId === teamId)?.subTeamLabel ?? teamId;
      columns.push({
        header: label,
        namesAt: (timeNum) => {
          const atTime = teamTasks.filter((tk) => new Date(tk.timeBlock.start).getTime() === timeNum);
          return atTime.flatMap((tk) =>
            getTaskAssignments(tk, schedule)
              .filter((s) => s.slot.subTeamId === teamId && s.participant)
              .map((s) => rtl(s.participant!.name)),
          );
        },
        colorAt: (timeNum) =>
          teamTasks.find((tk) => new Date(tk.timeBlock.start).getTime() === timeNum)?.color || '#7f8c8d',
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

    const categoryLabel = section.title;
    for (let i = 0; i < subTeamIds.length; i++) {
      const stId = subTeamIds[i];
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
        namesAt: (timeNum) => {
          const atTime = tasks.filter((tk) => new Date(tk.timeBlock.start).getTime() === timeNum);
          return atTime.flatMap((tk) =>
            getTaskAssignments(tk, schedule)
              .filter((s) => (s.slot.subTeamId ?? '') === capturedStId && s.participant)
              .map((s) => rtl(s.participant!.name)),
          );
        },
        colorAt: (timeNum) =>
          tasks.find((tk) => new Date(tk.timeBlock.start).getTime() === timeNum)?.color || '#7f8c8d',
      });
    }
  } else {
    // ── Flat strategy ──
    columns.push({
      header: section.title,
      namesAt: (timeNum) => {
        const atTime = tasks.filter((tk) => new Date(tk.timeBlock.start).getTime() === timeNum);
        return atTime.flatMap((tk) =>
          getTaskAssignments(tk, schedule)
            .filter((s) => s.participant)
            .map((s) => rtl(s.participant!.name)),
        );
      },
      colorAt: (timeNum) => tasks.find((tk) => new Date(tk.timeBlock.start).getTime() === timeNum)?.color || '#7f8c8d',
    });
  }

  return columns;
}

// ─── Fit-to-page Layout Planning ─────────────────────────────────────────────

/** A positioned, reshape-resolved section ready to render. */
interface RenderRegion {
  label: string;
  x: number;
  y: number;
  width: number;
  columns: LogicalColumn[];
  uniqueTimes: number[];
  /** Name sub-columns this section is split into (≥ 1). */
  nameCols: number;
}

interface DayLayout {
  rows: { row: number; regions: RenderRegion[] }[];
  fontSize: number;
  cellPadding: number;
  /** 1-indexed layout rows that must start a new page (overflow only). */
  pageBreakRows: number[];
}

/**
 * Build the one-page layout for a day: section grouping/order from the shared
 * layout-engine, then the pure fit planner decides reshaping + scaling so the
 * whole day fits a single page.
 */
function planDayLayoutForPdf(
  dayTasks: Task[],
  schedule: Schedule,
  pageW: number,
  pageH: number,
  topY: number,
): DayLayout | null {
  const sections = computeSectionMetrics(dayTasks);
  if (sections.length === 0) return null;

  const template = generateGridTemplate(assignRows(sections));
  const placementMap = new Map(template.placements.map((p) => [p.sectionId, p]));

  const meta = new Map<string, { section: SectionMetrics; columns: LogicalColumn[]; uniqueTimes: number[] }>();
  const descriptors: SectionDescriptor[] = [];
  const initialPlacements: InitialPlacement[] = [];

  for (const section of sections) {
    const placement = placementMap.get(section.id);
    if (!placement) continue;
    const columns = buildLogicalColumns(section, schedule);
    if (columns.length === 0) continue;
    const uniqueTimes = getUniqueStartTimes(section.tasks);
    meta.set(section.id, { section, columns, uniqueTimes });
    descriptors.push({
      id: section.id,
      displayOrder: section.displayOrder,
      logicalColCount: columns.length,
      nameGrid: uniqueTimes.map((tn) => columns.map((c) => c.namesAt(tn).length)),
    });
    initialPlacements.push({
      sectionId: section.id,
      row: placement.row,
      colStart: placement.colStart,
      colSpan: placement.colSpan,
    });
  }
  if (descriptors.length === 0) return null;

  const usableWidth = pageW - 2 * PAGE_MARGIN;
  const unitWidth = usableWidth / GRID_UNITS;
  const geometry: PageGeometry = {
    usableWidth,
    heightBudget: pageH - PAGE_MARGIN - topY,
    labelOffset: TABLE_LABEL_OFFSET,
    rowGap: ROW_GAP,
    colGapHalf: COL_GAP / 2,
    timeColWidth: TIME_COL_W,
    minNameColWidth: MIN_NAME_COL_W,
    gridUnits: GRID_UNITS,
  };

  const plan = planDayLayout({ sections: descriptors, initialPlacements, geometry, levers: DEFAULT_LEVERS });

  const rowMap = new Map<number, RenderRegion[]>();
  for (const ps of plan.sections) {
    const m = meta.get(ps.id);
    if (!m) continue;
    // RTL placement: grid column 1 is rightmost (same maths as the legacy grid).
    const x = pageW - PAGE_MARGIN - (ps.colStart - 1 + ps.colSpan) * unitWidth;
    const region: RenderRegion = {
      label: m.section.title,
      x,
      y: topY,
      width: ps.width,
      columns: m.columns,
      uniqueTimes: m.uniqueTimes,
      nameCols: Math.max(1, ps.nameCols),
    };
    if (!rowMap.has(ps.row)) rowMap.set(ps.row, []);
    rowMap.get(ps.row)!.push(region);
  }

  const rows = [...rowMap.keys()].sort((a, b) => a - b).map((row) => ({ row, regions: rowMap.get(row)! }));

  return { rows, fontSize: plan.fontSize, cellPadding: plan.cellPadding, pageBreakRows: plan.pageBreakRows };
}

// ─── Unified PDF Section Table Renderer ─────────────────────────────────────

const emptyCellStyle = {
  halign: 'center' as const,
  textColor: [190, 190, 190] as [number, number, number],
};
const filledCellStyle = (hexColor: string) => ({
  halign: 'center' as const,
  fillColor: tint(hexColor) as [number, number, number],
});

/**
 * Render one section's table. Each logical column is expanded into `nameCols`
 * physical sub-columns; that cell's names are distributed column-major
 * (top-to-bottom, then next sub-column) so the cell is ⌈N / nameCols⌉ lines
 * tall instead of N. The logical header spans its sub-columns. Returns finalY.
 */
function renderSectionTablePdf(
  doc: jsPDF,
  columns: LogicalColumn[],
  uniqueTimes: number[],
  region: { label: string; x: number; y: number; width: number },
  opts: { fontSize: number; cellPadding: number; nameCols: number },
): number {
  if (columns.length === 0) return region.y;
  const nameCols = Math.max(1, opts.nameCols);

  // Section label
  doc.setFontSize(opts.fontSize);
  doc.setTextColor(80, 80, 80);
  doc.text(rtl(region.label), region.x + region.width - 1, region.y, { align: 'right' });
  const tableY = region.y + TABLE_LABEL_OFFSET;

  // Header: one cell per logical column spanning its sub-columns + time column.
  const head: CellDef[] = [
    ...columns.map(
      (c) => ({ content: rtl(c.header), colSpan: nameCols, styles: { halign: 'center' as const } }) as CellDef,
    ),
    { content: rtl('זמן'), styles: { halign: 'center' as const } } as CellDef,
  ];

  const body: CellDef[][] = uniqueTimes.map((timeNum) => {
    const cells: CellDef[] = [];
    for (const col of columns) {
      const names = col.namesAt(timeNum);
      if (names.length === 0) {
        // Genuinely unfilled — show one "—" marker, rest blank.
        for (let j = 0; j < nameCols; j++) {
          cells.push({ content: j === 0 ? '—' : '', styles: emptyCellStyle } as CellDef);
        }
      } else {
        const color = col.colorAt(timeNum);
        const perCol = Math.ceil(names.length / nameCols);
        for (let j = 0; j < nameCols; j++) {
          const bucket = names.slice(j * perCol, (j + 1) * perCol).join('\n');
          cells.push({ content: bucket, styles: filledCellStyle(color) } as CellDef);
        }
      }
    }
    cells.push({ content: fmtTime(new Date(timeNum)), styles: { halign: 'center' as const } } as CellDef);
    return cells;
  });

  // Column widths: time col fixed, the rest split evenly across all sub-columns.
  const physicalDataCols = columns.length * nameCols;
  const subColW = (region.width - TIME_COL_W) / physicalDataCols;
  const colStyles: Record<number, Partial<{ cellWidth: number }>> = {};
  for (let i = 0; i < physicalDataCols; i++) colStyles[i] = { cellWidth: subColW };
  colStyles[physicalDataCols] = { cellWidth: TIME_COL_W };

  const tableOpts = {
    ...tblDefaults(tableY, opts.fontSize, opts.cellPadding),
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
 * Render a single day's schedule using the fit planner for spatial
 * arrangement, scaling, and multi-name-column reshaping. The day is guaranteed
 * to occupy exactly one page unless it is genuinely degenerate (more time-rows
 * than physically fit at the floor config), in which case it breaks only at
 * whole layout-row boundaries.
 */
function renderDayPage(doc: jsPDF, schedule: Schedule, dayIndex: number, dayStartHour: number = 5): void {
  // Day 0 (continuity context): mark the title clearly so the printed page
  // can never be confused with a generated day. The schedule passed in for
  // d=0 is the synthetic Day-0 Schedule built from the continuity snapshot.
  const isDay0 = dayIndex === 0;
  // Frozen op-day count for the "מתוך N" subtitle — periodDays, never a
  // task-bearing-day cardinality (which would print "out of 5" on a 7-day
  // schedule whose tasks skip op-days 1/7). See getNumDays' doc.
  const numDays = schedule.periodDays;

  const titleMain = isDay0 ? 'יום 0 — הקשר' : `יום ${dayIndex}`;
  const titleSub = isDay0 ? 'מהשבצ"ק הקודם · קריאה בלבד' : `מתוך ${numDays}`;
  let topY = drawTitle(doc, titleMain, titleSub);

  const dayTasks = getTasksForDay(schedule, dayIndex, dayStartHour);
  if (dayTasks.length === 0) {
    doc.setFontSize(10);
    doc.setTextColor(150, 150, 150);
    doc.text(rtl('אין משימות ביום זה'), doc.internal.pageSize.getWidth() / 2, topY + 15, { align: 'center' });
    return;
  }

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const layout = planDayLayoutForPdf(dayTasks, schedule, pageW, pageH, topY);
  if (!layout) return;

  const breakRows = new Set(layout.pageBreakRows);
  let currentY = topY;
  let firstRow = true;
  for (const { row, regions } of layout.rows) {
    if (!firstRow && breakRows.has(row)) {
      doc.addPage();
      topY = drawTitle(doc, titleMain, `${titleSub} · המשך`);
      currentY = topY;
    }
    let rowBottomY = currentY;
    for (const region of regions) {
      region.y = currentY;
      const bottomY = renderSectionTablePdf(doc, region.columns, region.uniqueTimes, region, {
        fontSize: layout.fontSize,
        cellPadding: layout.cellPadding,
        nameCols: region.nameCols,
      });
      rowBottomY = Math.max(rowBottomY, bottomY);
    }
    currentY = rowBottomY + ROW_GAP;
    firstRow = false;
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

/** Canvas → opaque-white PNG blob. */
function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))), 'image/png'),
  );
}

/** Render one PDF page to an opaque-white canvas at the target raster width. */
async function renderPageToCanvas(
  pdf: { getPage: (n: number) => Promise<any> },
  pageNum: number,
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNum);
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
  return canvas;
}

/**
 * Rasterise EVERY page of a PDF blob to a single opaque-white PNG. Normally the
 * day fits one page (the fit planner guarantees it), so this is a single page;
 * if a genuinely degenerate day spilled onto extra pages they are stacked
 * vertically into one tall image so the share/download never silently drops
 * content.
 */
async function rasterizeAllPagesToPng(pdfBlob: Blob): Promise<Blob> {
  const data = new Uint8Array(await pdfBlob.arrayBuffer());
  const pdfjs = await loadPdfjs();
  // Embedded Rubik font + no CID/standard fonts ⇒ no cMap/standardFont assets
  // needed ⇒ fully offline / file:// safe.
  const pdf = await pdfjs.getDocument({ data }).promise;
  try {
    const pageCount = pdf.numPages;
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 1; i <= pageCount; i++) {
      canvases.push(await renderPageToCanvas(pdf, i));
    }
    if (canvases.length === 1) return await canvasToPng(canvases[0]);

    const maxW = Math.max(...canvases.map((c) => c.width));
    const totalH = canvases.reduce((sum, c) => sum + c.height, 0);
    const combined = document.createElement('canvas');
    combined.width = maxW;
    combined.height = totalH;
    const g = combined.getContext('2d');
    if (!g) throw new Error('2D canvas context unavailable');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, combined.width, combined.height);
    let y = 0;
    for (const c of canvases) {
      g.drawImage(c, 0, y);
      y += c.height;
    }
    return await canvasToPng(combined);
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
  const png = await rasterizeAllPagesToPng(doc.output('blob'));
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
  // One page per op-day across the whole frozen period. Bounding by
  // getNumDays (a task-bearing-day cardinality) would silently drop any
  // op-day whose absolute index exceeds the count — e.g. periodDays=7 with
  // tasks on op-days 2..6 loses op-day 6 entirely. See getNumDays' doc.
  const numDays = schedule.periodDays;
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
