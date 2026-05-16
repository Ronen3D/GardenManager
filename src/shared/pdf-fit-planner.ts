/**
 * Pure fit-to-one-page planner for the daily PDF export.
 *
 * The daily PDF stacks per-section tables (jsPDF-AutoTable) into a grid. With a
 * dense day (a task with many slots → many people per cell) the naive layout
 * overflows onto 3–4 pages. This module decides — *before* anything is drawn —
 * a layout configuration that makes the whole day fit on a single A4-landscape
 * page: how many "name sub-columns" to split each section into, what font size
 * and cell padding to use, and (only in genuinely degenerate cases) where to
 * break across pages.
 *
 * It is intentionally pure (no DOM, no jsPDF) so it can be unit-tested in the
 * Node `npm run test` harness. The height model mirrors AutoTable's own
 * geometry exactly:
 *
 *   cellHeight = lineCount * (fontSize / scaleFactor * lineHeightFactor)
 *                + verticalPadding
 *   rowHeight  = max(cellHeight over the row's cells)
 *   tableHeight = headerHeight + Σ rowHeight
 *
 * This is exact because the PDF tables use `overflow: 'ellipsize'` (no text
 * wrapping), so a cell's rendered line count equals exactly the number of
 * `\n`-joined names it holds. See jspdf-autotable `Cell.getContentHeight`
 * (dist/jspdf.plugin.autotable.js) and jsPDF mm scaleFactor `72 / 25.4`.
 *
 * `pdf-export.ts` still runs an authoritative `__createTable` measurement pass
 * before drawing; this planner picks the configuration, the dry pass confirms.
 */

// ─── jsPDF / AutoTable geometry constants ────────────────────────────────────

/** jsPDF scale factor for unit `mm` — `72 / 25.4`. */
export const SCALE_FACTOR_MM = 72 / 25.4;

/** jsPDF default line-height factor (we never override `setLineHeightFactor`). */
export const LINE_HEIGHT_FACTOR = 1.15;

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Structural description of one section's table content (assignment-resolved). */
export interface SectionDescriptor {
  id: string;
  /** Lower sorts earlier (matches layout-engine display order). */
  displayOrder: number;
  /** Number of logical strategy columns (flat = 1; sub-team/multi-source = N). */
  logicalColCount: number;
  /**
   * Assigned-name counts: `nameGrid[r][c]` = number of participant names in
   * time-row `r`, logical column `c`. `length` = number of time rows;
   * each inner array has `logicalColCount` entries.
   */
  nameGrid: number[][];
}

/** One section's initial grid placement (from layout-engine generateGridTemplate). */
export interface InitialPlacement {
  sectionId: string;
  /** 1-indexed grid row. */
  row: number;
  /** 1-indexed grid column start (1..gridUnits). */
  colStart: number;
  /** Span in grid units. */
  colSpan: number;
}

/** Page geometry + AutoTable style constants, all in mm unless noted. */
export interface PageGeometry {
  /** Usable grid width = pageWidth − 2·pageMargin. */
  usableWidth: number;
  /** Total vertical budget for all stacked layout rows (incl. labels & gaps). */
  heightBudget: number;
  /** Space reserved above each section table for its label. */
  labelOffset: number;
  /** Gap between vertically-stacked layout rows. */
  rowGap: number;
  /** Width subtracted from a section when it does not span the full grid
   *  (mirrors pdf-export `COL_GAP / 2`). */
  colGapHalf: number;
  /** Width of the rightmost time column. */
  timeColWidth: number;
  /** Minimum readable width for one name sub-column. */
  minNameColWidth: number;
  /** Total grid units (Bootstrap-style 12). */
  gridUnits: number;
}

/** Quality-ordered shrink levers. */
export interface FitLevers {
  /** Candidate font sizes, descending (first = best quality). */
  fontSizes: number[];
  /** Candidate per-side cell paddings (mm), descending. Vertical = 2·value. */
  cellPaddings: number[];
  /** Fixed per-side header padding (mm). Header vertical = 2·value. */
  headPadding: number;
  /** Hard cap on name sub-columns regardless of available width. */
  maxNameCols: number;
}

export interface PlanInput {
  sections: SectionDescriptor[];
  initialPlacements: InitialPlacement[];
  geometry: PageGeometry;
  levers: FitLevers;
}

// ─── Output ──────────────────────────────────────────────────────────────────

export interface PlacedSection {
  id: string;
  /** 1-indexed grid row. */
  row: number;
  colStart: number;
  colSpan: number;
  /** Resolved section width (mm). */
  width: number;
  /** Chosen number of name sub-columns (≥ 1). */
  nameCols: number;
}

export interface PlanResult {
  sections: PlacedSection[];
  fontSize: number;
  /** Chosen per-side cell padding (mm). */
  cellPadding: number;
  /** Predicted total stacked height (mm). */
  predictedHeight: number;
  /** True ⇒ cannot fit one page even at the floor config (extreme fallback). */
  overflow: boolean;
  /**
   * When `overflow`, the 1-indexed layout-row numbers that must START a new
   * PDF page (page breaks happen only at whole layout-row boundaries — never
   * mid-table). Empty when it fits one page.
   */
  pageBreakRows: number[];
}

// ─── Default levers ──────────────────────────────────────────────────────────

export const DEFAULT_LEVERS: FitLevers = {
  fontSizes: [9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5],
  cellPaddings: [1.8, 1.4, 1.0, 0.7],
  headPadding: 1.5,
  maxNameCols: 12,
};

// ─── Height model ────────────────────────────────────────────────────────────

/** Per-line height in mm for a given font size. */
function lineHeightMm(fontSize: number): number {
  return (fontSize / SCALE_FACTOR_MM) * LINE_HEIGHT_FACTOR;
}

/**
 * Resolve a section's pixel width from its grid span — mirrors the exact
 * arithmetic in pdf-export `computeGridLayoutSmart`.
 */
export function resolveWidth(colSpan: number, geo: PageGeometry): number {
  const unit = geo.usableWidth / geo.gridUnits;
  return colSpan * unit - (colSpan < geo.gridUnits ? geo.colGapHalf : 0);
}

/**
 * Maximum name sub-columns a section can use at a given width: each logical
 * column is split into `nameCols` physical sub-columns and every sub-column
 * must stay ≥ `minNameColWidth`.
 */
export function maxNameColsFor(width: number, logicalColCount: number, geo: PageGeometry, cap: number): number {
  const nameArea = width - geo.timeColWidth;
  if (nameArea <= 0) return 1;
  const perLogical = nameArea / logicalColCount;
  const fit = Math.floor(perLogical / geo.minNameColWidth);
  return Math.max(1, Math.min(cap, fit));
}

/** Height (mm) of one section's table for a given config. */
export function sectionHeight(
  desc: SectionDescriptor,
  nameCols: number,
  fontSize: number,
  cellPadding: number,
  headPadding: number,
): number {
  const lh = lineHeightMm(fontSize);
  const headerHeight = lh + 2 * headPadding;
  let bodyHeight = 0;
  for (const rowCounts of desc.nameGrid) {
    let rowLines = 1; // empty cells render '—' (1 line); row is ≥ 1 line
    for (const count of rowCounts) {
      const linesInCell = count <= 0 ? 1 : Math.ceil(count / nameCols);
      if (linesInCell > rowLines) rowLines = linesInCell;
    }
    bodyHeight += rowLines * lh + 2 * cellPadding;
  }
  return headerHeight + bodyHeight;
}

/** Group placements into ordered layout rows (1-indexed → list of section ids). */
function rowsOf(placements: InitialPlacement[]): Map<number, InitialPlacement[]> {
  const m = new Map<number, InitialPlacement[]>();
  for (const p of placements) {
    if (!m.has(p.row)) m.set(p.row, []);
    m.get(p.row)!.push(p);
  }
  return m;
}

/**
 * Total stacked page height for a full configuration, plus each layout row's
 * own height (used for overflow page-break splitting).
 */
function measure(
  descById: Map<string, SectionDescriptor>,
  placements: InitialPlacement[],
  nameColsById: Map<string, number>,
  fontSize: number,
  cellPadding: number,
  geo: PageGeometry,
  headPadding: number,
): { total: number; rowHeights: Map<number, number>; sortedRows: number[] } {
  const rowMap = rowsOf(placements);
  const sortedRows = [...rowMap.keys()].sort((a, b) => a - b);
  const rowHeights = new Map<number, number>();
  for (const r of sortedRows) {
    let rowMax = 0;
    for (const p of rowMap.get(r)!) {
      const desc = descById.get(p.sectionId);
      if (!desc) continue;
      const h = sectionHeight(desc, nameColsById.get(p.sectionId) ?? 1, fontSize, cellPadding, headPadding);
      if (h > rowMax) rowMax = h;
    }
    rowHeights.set(r, geo.labelOffset + rowMax);
  }
  let total = 0;
  for (const r of sortedRows) total += rowHeights.get(r)!;
  total += geo.rowGap * Math.max(0, sortedRows.length - 1);
  return { total, rowHeights, sortedRows };
}

// ─── Planner ─────────────────────────────────────────────────────────────────

/**
 * Decide a one-page layout via deterministic greedy descent. Quality order:
 *   1. grow name sub-columns on the tallest section of the worst row,
 *   2. reduce cell padding,
 *   3. reduce font size,
 *   4. re-pack: move the single tallest section to its own full-width row
 *      (maximises its width → unlocks more sub-columns),
 *   5. if still over at the floor → flag overflow + clean row-boundary breaks.
 */
export function planDayLayout(input: PlanInput): PlanResult {
  const { sections, geometry: geo, levers } = input;
  const descById = new Map(sections.map((s) => [s.id, s]));

  // Working placement list (mutated only by the re-pack step).
  let placements: InitialPlacement[] = input.initialPlacements.map((p) => ({ ...p }));
  const widthOf = (p: InitialPlacement) => resolveWidth(p.colSpan, geo);
  const capFor = (p: InitialPlacement) => {
    const d = descById.get(p.sectionId);
    return d ? maxNameColsFor(widthOf(p), d.logicalColCount, geo, levers.maxNameCols) : 1;
  };

  const nameCols = new Map<string, number>(sections.map((s) => [s.id, 1]));
  let repacked = false;

  // Try every (font, padding) pair from best to worst; within each, grow
  // name-columns greedily on the worst row until it fits or growth is capped.
  const attempt = (): { fit: boolean; fontSize: number; cellPadding: number; predicted: number } => {
    for (const fontSize of levers.fontSizes) {
      for (const cellPadding of levers.cellPaddings) {
        // Reset sub-columns for each (font,padding) so we use the *least*
        // reshaping that still fits at the best possible font/padding.
        for (const s of sections) nameCols.set(s.id, 1);

        // Greedy name-column growth, bounded by (sections × maxCols) steps.
        const maxSteps = sections.length * levers.maxNameCols + 1;
        for (let step = 0; step <= maxSteps; step++) {
          const m = measure(descById, placements, nameCols, fontSize, cellPadding, geo, levers.headPadding);
          if (m.total <= geo.heightBudget) {
            return { fit: true, fontSize, cellPadding, predicted: m.total };
          }
          // Worst (tallest) row → its tallest growable section.
          let worstRow = -1;
          let worstH = -1;
          for (const [r, h] of m.rowHeights) {
            if (h > worstH) {
              worstH = h;
              worstRow = r;
            }
          }
          const rowPlacements = placements.filter((p) => p.row === worstRow);
          let target: InitialPlacement | null = null;
          let targetH = -1;
          for (const p of rowPlacements) {
            const d = descById.get(p.sectionId);
            if (!d) continue;
            if ((nameCols.get(p.sectionId) ?? 1) >= capFor(p)) continue; // capped
            const h = sectionHeight(d, nameCols.get(p.sectionId) ?? 1, fontSize, cellPadding, levers.headPadding);
            if (h > targetH) {
              targetH = h;
              target = p;
            }
          }
          if (!target) break; // nothing growable in the worst row → next lever
          nameCols.set(target.sectionId, (nameCols.get(target.sectionId) ?? 1) + 1);
        }
      }
    }
    const m = measure(
      descById,
      placements,
      nameCols,
      levers.fontSizes[levers.fontSizes.length - 1],
      levers.cellPaddings[levers.cellPaddings.length - 1],
      geo,
      levers.headPadding,
    );
    return {
      fit: false,
      fontSize: levers.fontSizes[levers.fontSizes.length - 1],
      cellPadding: levers.cellPaddings[levers.cellPaddings.length - 1],
      predicted: m.total,
    };
  };

  let res = attempt();

  // Re-pack once: give the single tallest section its own full-width row so it
  // can use the most sub-columns, then retry the whole descent.
  if (!res.fit && !repacked && sections.length > 1) {
    repacked = true;
    const floorFont = levers.fontSizes[levers.fontSizes.length - 1];
    const floorPad = levers.cellPaddings[levers.cellPaddings.length - 1];
    let tallestId: string | null = null;
    let tallestH = -1;
    for (const s of sections) {
      const h = sectionHeight(s, 1, floorFont, floorPad, levers.headPadding);
      if (h > tallestH) {
        tallestH = h;
        tallestId = s.id;
      }
    }
    if (tallestId) {
      const others = placements.filter((p) => p.sectionId !== tallestId);
      // Re-number the remaining rows compactly, then append a dedicated
      // full-width row for the tallest section.
      const remainingRows = [...new Set(others.map((p) => p.row))].sort((a, b) => a - b);
      const renumber = new Map(remainingRows.map((r, i) => [r, i + 1]));
      const next: InitialPlacement[] = others.map((p) => ({ ...p, row: renumber.get(p.row)! }));
      next.push({
        sectionId: tallestId,
        row: remainingRows.length + 1,
        colStart: 1,
        colSpan: geo.gridUnits,
      });
      placements = next;
      res = attempt();
    }
  }

  // Resolve final per-section placement output.
  const placed: PlacedSection[] = placements.map((p) => ({
    id: p.sectionId,
    row: p.row,
    colStart: p.colStart,
    colSpan: p.colSpan,
    width: widthOf(p),
    nameCols: nameCols.get(p.sectionId) ?? 1,
  }));
  placed.sort((a, b) => a.row - b.row || a.colStart - b.colStart);

  if (res.fit) {
    return {
      sections: placed,
      fontSize: res.fontSize,
      cellPadding: res.cellPadding,
      predictedHeight: res.predicted,
      overflow: false,
      pageBreakRows: [],
    };
  }

  // Extreme fallback: keep the floor config and break across pages ONLY at
  // whole layout-row boundaries (a single table is never split mid-rows).
  const m = measure(descById, placements, nameCols, res.fontSize, res.cellPadding, geo, levers.headPadding);
  const pageBreakRows: number[] = [];
  let pageUsed = 0;
  for (let i = 0; i < m.sortedRows.length; i++) {
    const r = m.sortedRows[i];
    const rh = m.rowHeights.get(r)! + (i > 0 ? geo.rowGap : 0);
    if (pageUsed > 0 && pageUsed + rh > geo.heightBudget) {
      pageBreakRows.push(r);
      pageUsed = m.rowHeights.get(r)!;
    } else {
      pageUsed += rh;
    }
  }
  return {
    sections: placed,
    fontSize: res.fontSize,
    cellPadding: res.cellPadding,
    predictedHeight: m.total,
    overflow: true,
    pageBreakRows,
  };
}
