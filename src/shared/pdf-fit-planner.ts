/**
 * Pure 2-D layout packer for the daily PDF export.
 *
 * The daily PDF places per-section tables (jsPDF-AutoTable) on an A4-landscape
 * page. The old design stacked sections into fixed horizontal *row bands*
 * (`layout-engine.assignRows`/`generateGridTemplate`); a band's height was its
 * tallest member, so the rectangle below a short section sharing a band with a
 * tall one was permanently dead space — dense days wasted half the page and
 * spilled tiny sections onto a near-empty second page.
 *
 * This module replaces that with a true **2-D bin packer** (MAXRECTS /
 * free-rectangle, best-short-side-fit). Each section is an atomic rectangle
 * whose width is elastic via "name sub-columns" (`nameCols`) and whose height
 * comes from the AutoTable-exact model below. The packer reclaims the dead
 * rectangles by stacking short sections beside/below tall ones. A quality
 * descent (grow name-cols → shrink padding → shrink font, floor 7 pt) wraps the
 * packer; only a genuinely impossible day spills to a **second, balanced** page.
 *
 * It is intentionally pure (no DOM, no jsPDF) so it can be unit-tested in the
 * Node `npm run test` / `npm run test:persistence` harnesses. The height model
 * mirrors AutoTable's own geometry exactly:
 *
 *   cellHeight = lineCount * (fontSize / scaleFactor * lineHeightFactor)
 *                + verticalPadding
 *   rowHeight  = max(cellHeight over the row's cells)
 *   tableHeight = headerHeight + Σ rowHeight
 *
 * This is exact because the PDF tables use `overflow: 'ellipsize'` (no text
 * wrapping), so a cell's rendered line count equals exactly the number of
 * `\n`-joined names it holds. Bold names (font ≤ BOLD_NAME_MAX_FONT) change
 * glyph width, never line height, so the model stays exact. `pdf-export.ts`
 * still runs an authoritative `__createTable` measurement before drawing; this
 * planner picks the configuration, the dry pass confirms.
 */

// ─── jsPDF / AutoTable geometry constants ────────────────────────────────────

/** jsPDF scale factor for unit `mm` — `72 / 25.4`. */
export const SCALE_FACTOR_MM = 72 / 25.4;

/** jsPDF default line-height factor (we never override `setLineHeightFactor`). */
export const LINE_HEIGHT_FACTOR = 1.15;

/** Participant names render bold at font sizes ≤ this (mm/pt). Bold lifts
 *  small-text legibility at zero vertical cost (line height is unchanged). */
export const BOLD_NAME_MAX_FONT = 7.5;

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

/** Page geometry + AutoTable style constants, all in mm unless noted. */
export interface PageGeometry {
  /** Usable content width = pageWidth − 2·pageMargin. */
  usableWidth: number;
  /** Vertical budget for one page's content (below the title rule). */
  heightBudget: number;
  /** Space reserved above each section table for its label. */
  labelOffset: number;
  /** Minimum vertical gap between stacked sections. */
  rowGap: number;
  /** Minimum horizontal gap between side-by-side sections. */
  colGap: number;
  /** Width of the rightmost time column. */
  timeColWidth: number;
  /** Minimum readable width for one name sub-column (hard floor). */
  minNameColWidth: number;
  /** Target (comfortable) width for one name sub-column. */
  idealNameColWidth: number;
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
  /** Ceiling (mm) the spread pass may grow `cellPadding` to. Default 3.0. */
  maxSpreadCellPadding?: number;
  /** Skip the spread pass — preserve the raw Phase 1 placements. Default false. */
  disableSpread?: boolean;
}

export interface PlanInput {
  /** Sections in display order (caller guarantees displayOrder-sorted). */
  sections: SectionDescriptor[];
  geometry: PageGeometry;
  levers: FitLevers;
}

// ─── Output ──────────────────────────────────────────────────────────────────

export interface PlacedSection {
  id: string;
  /** mm, left-origin within the usable box (0 = left edge). pdf-export mirrors
   *  this for RTL. */
  x: number;
  /** mm, top-origin within the page content area (0 = just below the rule). */
  y: number;
  /** Resolved table width (mm) — time col + name sub-columns. */
  width: number;
  /** Full footprint height (mm) — label offset + table height. */
  height: number;
  /** Chosen number of name sub-columns (≥ 1). */
  nameCols: number;
  /** 0-indexed page this section lands on. */
  page: number;
  /** True ⇒ this section alone exceeds a full page; pdf-export must let
   *  AutoTable paginate it natively (unsplittable atomic table fallback). */
  oversize?: boolean;
}

export interface PlanResult {
  sections: PlacedSection[];
  fontSize: number;
  /** Chosen per-side cell padding (mm). */
  cellPadding: number;
  /** Predicted used height (mm) of the fullest page. */
  predictedHeight: number;
  /** Number of PDF pages this day occupies (1 in the common case). */
  pageCount: number;
  /** True ⇒ could not fit one page; spilled to ≥2 (balanced) pages. */
  overflow: boolean;
}

// ─── Default levers ──────────────────────────────────────────────────────────

export const DEFAULT_LEVERS: FitLevers = {
  // Floor 7 pt — names go bold at ≤ BOLD_NAME_MAX_FONT for legibility.
  fontSizes: [9, 8.5, 8, 7.5, 7],
  cellPaddings: [1.8, 1.4, 1.0, 0.7],
  headPadding: 1.5,
  maxNameCols: 12,
  maxSpreadCellPadding: 3.0,
};

/** Step (mm) for the 2-page balancing cap search. */
const CAP_STEP = 2;

/**
 * Page is "dense" — and the spread pass is a no-op — when both axes have less
 * than this much empty space (~one minimum name sub-column). Keeps already-full
 * pages byte-identical to pre-spread output.
 */
const SPREAD_MIN_SLACK_MM = 10;

/** Lever C step (mm) — `cellPadding` grows in 0.4 mm increments. */
const SPREAD_PAD_STEP = 0.4;

// ─── Height / width model ────────────────────────────────────────────────────

/** Per-line height in mm for a given font size. */
function lineHeightMm(fontSize: number): number {
  return (fontSize / SCALE_FACTOR_MM) * LINE_HEIGHT_FACTOR;
}

/**
 * Maximum name sub-columns a section can use at a given available width: each
 * logical column splits into `nameCols` physical sub-columns and every
 * sub-column must stay ≥ `minNameColWidth`.
 */
export function maxNameColsFor(width: number, logicalColCount: number, geo: PageGeometry, cap: number): number {
  const nameArea = width - geo.timeColWidth;
  if (nameArea <= 0) return 1;
  const perLogical = nameArea / logicalColCount;
  const fit = Math.floor(perLogical / geo.minNameColWidth);
  return Math.max(1, Math.min(cap, fit));
}

/**
 * A section's natural drawn width (mm) at a given `nameCols`: comfortable
 * (`idealNameColWidth`) sub-columns, never below the readable floor
 * (`minNameColWidth`), never wider than the page.
 */
export function naturalWidth(desc: SectionDescriptor, nameCols: number, geo: PageGeometry): number {
  const cols = desc.logicalColCount * nameCols;
  const minW = geo.timeColWidth + cols * geo.minNameColWidth;
  const idealW = geo.timeColWidth + cols * geo.idealNameColWidth;
  return Math.max(minW, Math.min(idealW, geo.usableWidth));
}

/** Height (mm) of one section's table for a given config (no label offset). */
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

/** Full footprint height (label + table) of a section for a given config. */
function footprintHeight(
  desc: SectionDescriptor,
  nameCols: number,
  fontSize: number,
  cellPadding: number,
  geo: PageGeometry,
  headPadding: number,
): number {
  return geo.labelOffset + sectionHeight(desc, nameCols, fontSize, cellPadding, headPadding);
}

// ─── MAXRECTS 2-D bin packer ─────────────────────────────────────────────────

interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PackItem {
  id: string;
  /** Real drawn width/height (mm), not inflated by the gap. */
  w: number;
  h: number;
}

interface PackPlacement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bin: number;
  oversize: boolean;
}

const EPS = 1e-6;

function fits(fr: FreeRect, w: number, h: number): boolean {
  return w <= fr.w + EPS && h <= fr.h + EPS;
}

function containedIn(a: FreeRect, b: FreeRect): boolean {
  return a.x >= b.x - EPS && a.y >= b.y - EPS && a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS;
}

/** Lexicographic "a < b" with an epsilon tolerance per component. */
function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - EPS) return true;
    if (a[i] > b[i] + EPS) return false;
  }
  return false;
}

/** Best-short-side-fit pick. Deterministic tie-break: shorter leftover side,
 *  then longer leftover side, then topmost (y), then leftmost (x). */
function chooseFreeRect(free: FreeRect[], w: number, h: number): FreeRect | null {
  let best: FreeRect | null = null;
  let bestScore: number[] | null = null;
  for (const fr of free) {
    if (!fits(fr, w, h)) continue;
    const leftH = fr.w - w;
    const leftV = fr.h - h;
    const score = [Math.min(leftH, leftV), Math.max(leftH, leftV), fr.y, fr.x];
    if (bestScore == null || lexLess(score, bestScore)) {
      best = fr;
      bestScore = score;
    }
  }
  return best;
}

/** MAXRECTS split: replace every free rect overlapping `R` with its uncovered
 *  sub-rectangles, then drop rects contained in another. */
function splitFreeRects(free: FreeRect[], R: FreeRect): FreeRect[] {
  const out: FreeRect[] = [];
  for (const F of free) {
    const overlaps = R.x < F.x + F.w - EPS && R.x + R.w > F.x + EPS && R.y < F.y + F.h - EPS && R.y + R.h > F.y + EPS;
    if (!overlaps) {
      out.push(F);
      continue;
    }
    if (R.x > F.x + EPS) out.push({ x: F.x, y: F.y, w: R.x - F.x, h: F.h });
    if (R.x + R.w < F.x + F.w - EPS) out.push({ x: R.x + R.w, y: F.y, w: F.x + F.w - (R.x + R.w), h: F.h });
    if (R.y > F.y + EPS) out.push({ x: F.x, y: F.y, w: F.w, h: R.y - F.y });
    if (R.y + R.h < F.y + F.h - EPS) out.push({ x: F.x, y: R.y + R.h, w: F.w, h: F.y + F.h - (R.y + R.h) });
  }
  // Prune rects fully contained in another (O(n²); n is tiny).
  const pruned: FreeRect[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i].w <= EPS || out[i].h <= EPS) continue;
    let contained = false;
    for (let j = 0; j < out.length; j++) {
      if (i === j || out[j].w <= EPS || out[j].h <= EPS) continue;
      if (containedIn(out[i], out[j]) && !(containedIn(out[j], out[i]) && j < i)) {
        contained = true;
        break;
      }
    }
    if (!contained) pruned.push(out[i]);
  }
  return pruned;
}

/**
 * Pack `items` (in the given order) into bins of `binW × binH`, separating
 * neighbours by `gapW`/`gapH`. Returns placements or `null` when the items need
 * more than `maxBins` bins. When `allowOversizeOwnBin`, an item taller/wider
 * than an empty bin is given its own dedicated bin (flagged `oversize`) instead
 * of failing — used only by the unreachable N-page safety net.
 */
function packBins(
  items: PackItem[],
  binW: number,
  binH: number,
  gapW: number,
  gapH: number,
  maxBins: number,
  allowOversizeOwnBin: boolean,
): PackPlacement[] | null {
  const bins: FreeRect[][] = [];
  const newBin = (): FreeRect[] => [{ x: 0, y: 0, w: binW + gapW, h: binH + gapH }];
  const placements: PackPlacement[] = [];

  for (const item of items) {
    // An item bigger than an empty bin is unsplittable here. In bounded
    // attempts that fails the attempt; the N-page safety net dedicates it a
    // page of its own (rendered via AutoTable's native pagination).
    if (item.w > binW + EPS || item.h > binH + EPS) {
      if (!allowOversizeOwnBin) return null;
      const ownBin = bins.length;
      bins.push([]); // dedicated, fully consumed
      placements.push({ id: item.id, x: 0, y: 0, w: item.w, h: item.h, bin: ownBin, oversize: true });
      continue;
    }

    const iw = item.w + gapW;
    const ih = item.h + gapH;
    let placed = false;
    for (let bi = 0; ; bi++) {
      if (bi === bins.length) {
        if (bins.length >= maxBins) break; // out of page budget for this attempt
        bins.push(newBin());
      }
      const fr = chooseFreeRect(bins[bi], iw, ih);
      if (fr) {
        placements.push({ id: item.id, x: fr.x, y: fr.y, w: item.w, h: item.h, bin: bi, oversize: false });
        bins[bi] = splitFreeRects(bins[bi], { x: fr.x, y: fr.y, w: iw, h: ih });
        placed = true;
        break;
      }
    }
    if (!placed) return null;
  }
  return placements;
}

// ─── Planner ─────────────────────────────────────────────────────────────────

function emptyResult(): PlanResult {
  return {
    sections: [],
    fontSize: DEFAULT_LEVERS.fontSizes[0],
    cellPadding: DEFAULT_LEVERS.cellPaddings[0],
    predictedHeight: 0,
    pageCount: 1,
    overflow: false,
  };
}

/**
 * Decide a layout via deterministic descent. Quality order:
 *   1. grow name sub-columns on the tallest growable section,
 *   2. reduce cell padding,
 *   3. reduce font size (floor 7 pt),
 *   4. open a 2nd page → restart at the best font, then balance the two pages,
 *   5. (unreachable) N pages at the floor, oversize sections on their own page.
 *
 * After step 1 succeeds, a **spread pass** (`spreadLayout`) grows cell padding
 * for breathing room and centers the cluster on the page — purely aesthetic,
 * never grows the page count, no-op on dense pages.
 */
export function planDayLayout(input: PlanInput): PlanResult {
  const { sections, geometry: geo, levers } = input;
  if (sections.length === 0) return emptyResult();

  const capFor = (s: SectionDescriptor) => maxNameColsFor(geo.usableWidth, s.logicalColCount, geo, levers.maxNameCols);

  const itemsFor = (nameCols: Map<string, number>, fontSize: number, cellPadding: number): PackItem[] =>
    sections.map((s) => {
      const nc = nameCols.get(s.id) ?? 1;
      return {
        id: s.id,
        w: naturalWidth(s, nc, geo),
        h: footprintHeight(s, nc, fontSize, cellPadding, geo, levers.headPadding),
      };
    });

  /**
   * Greedy descent: for each (font,padding) best→worst, grow name-cols on the
   * tallest growable section until the items fit ≤ `maxBins` bins of `binH`.
   * Returns the first (best-quality) fitting config, or null.
   */
  const attempt = (
    maxBins: number,
    binH: number,
  ): { placements: PackPlacement[]; fontSize: number; cellPadding: number; nameCols: Map<string, number> } | null => {
    for (const fontSize of levers.fontSizes) {
      for (const cellPadding of levers.cellPaddings) {
        const nameCols = new Map<string, number>(sections.map((s) => [s.id, 1]));
        const maxSteps = sections.length * levers.maxNameCols + 1;
        for (let step = 0; step <= maxSteps; step++) {
          const items = itemsFor(nameCols, fontSize, cellPadding);
          const packed = packBins(items, geo.usableWidth, binH, geo.colGap, geo.rowGap, maxBins, false);
          if (packed) return { placements: packed, fontSize, cellPadding, nameCols };
          // Grow the globally tallest growable section (biggest height-cut).
          let target: SectionDescriptor | null = null;
          let targetH = -1;
          for (const s of sections) {
            if ((nameCols.get(s.id) ?? 1) >= capFor(s)) continue;
            const h = footprintHeight(s, nameCols.get(s.id) ?? 1, fontSize, cellPadding, geo, levers.headPadding);
            if (h > targetH) {
              targetH = h;
              target = s;
            }
          }
          if (!target) break; // nothing growable → next (font,padding)
          nameCols.set(target.id, (nameCols.get(target.id) ?? 1) + 1);
        }
      }
    }
    return null;
  };

  const build = (placements: PackPlacement[], fontSize: number, cellPadding: number): PlanResult => {
    const pageCount = placements.reduce((m, p) => Math.max(m, p.bin + 1), 1);
    const pageBottom = new Map<number, number>();
    for (const p of placements) {
      pageBottom.set(p.bin, Math.max(pageBottom.get(p.bin) ?? 0, p.y + p.h));
    }
    const predictedHeight = [...pageBottom.values()].reduce((m, v) => Math.max(m, v), 0);
    const placed: PlacedSection[] = placements
      .map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        width: p.w,
        height: p.h,
        nameCols: 1,
        page: p.bin,
        ...(p.oversize ? { oversize: true } : {}),
      }))
      .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    return { sections: placed, fontSize, cellPadding, predictedHeight, pageCount, overflow: pageCount > 1 };
  };

  const withNameCols = (res: PlanResult, nameCols: Map<string, number>): PlanResult => {
    for (const s of res.sections) s.nameCols = nameCols.get(s.id) ?? 1;
    return res;
  };

  /**
   * Phase 1.5 — spread pass. After a successful 1-page fit, grow cell padding
   * for breathing room then center the cluster on the page. Width is left
   * exactly where Phase 1 chose it — growing `nameCols` post-fit was tried
   * and dropped because, on a sparse day with all 1-name cells, it inflates
   * single-row sections to span the full page and splits cells into mostly-
   * empty sub-cells (visible empty bordered cells, worse than the cramped
   * original). No-op when the page is already dense or `disableSpread` is set.
   */
  const spreadLayout = (fit: {
    placements: PackPlacement[];
    fontSize: number;
    cellPadding: number;
    nameCols: Map<string, number>;
  }): typeof fit => {
    let bboxW = 0;
    let bboxH = 0;
    for (const p of fit.placements) {
      bboxW = Math.max(bboxW, p.x + p.w);
      bboxH = Math.max(bboxH, p.y + p.h);
    }
    if (geo.usableWidth - bboxW < SPREAD_MIN_SLACK_MM && geo.heightBudget - bboxH < SPREAD_MIN_SLACK_MM) {
      return fit; // dense page — preserve byte-identical Phase 1 output
    }

    const tryPack = (pad: number): PackPlacement[] | null =>
      packBins(
        itemsFor(fit.nameCols, fit.fontSize, pad),
        geo.usableWidth,
        geo.heightBudget,
        geo.colGap,
        geo.rowGap,
        1,
        false,
      );

    let curPadding = fit.cellPadding;
    let curPlacements = fit.placements;

    // Lever C — grow cellPadding for breathing room (every row gains 2·Δpad).
    const padCap = levers.maxSpreadCellPadding ?? 3.0;
    while (curPadding + SPREAD_PAD_STEP <= padCap + EPS) {
      const trialPad = curPadding + SPREAD_PAD_STEP;
      const packed = tryPack(trialPad);
      if (!packed) break;
      curPadding = trialPad;
      curPlacements = packed;
    }

    // Lever D — center the final cluster on the page (mirror-safe under RTL).
    let finalW = 0;
    let finalH = 0;
    for (const p of curPlacements) {
      finalW = Math.max(finalW, p.x + p.w);
      finalH = Math.max(finalH, p.y + p.h);
    }
    const dx = Math.max(0, (geo.usableWidth - finalW) / 2);
    const dy = Math.max(0, (geo.heightBudget - finalH) / 2);
    if (dx > EPS || dy > EPS) {
      curPlacements = curPlacements.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
    }

    return { placements: curPlacements, fontSize: fit.fontSize, cellPadding: curPadding, nameCols: fit.nameCols };
  };

  // ── 1: single page ──
  const one = attempt(1, geo.heightBudget);
  if (one) {
    const spread = levers.disableSpread ? one : spreadLayout(one);
    return withNameCols(build(spread.placements, spread.fontSize, spread.cellPadding), spread.nameCols);
  }

  // ── 2: two balanced pages, at the best readable font ──
  const two = attempt(2, geo.heightBudget);
  if (two) {
    // Minimise the per-page cap that still fits ≤2 bins ⇒ both pages near the
    // cap ⇒ balanced & tight. Keep the font/padding/nameCols from `two`.
    const items = itemsFor(two.nameCols, two.fontSize, two.cellPadding);
    let best: PackPlacement[] | null = two.placements;
    for (let cap = Math.ceil(geo.heightBudget / 2); cap <= geo.heightBudget; cap += CAP_STEP) {
      const packed = packBins(items, geo.usableWidth, cap, geo.colGap, geo.rowGap, 2, false);
      if (packed) {
        best = packed;
        break;
      }
    }
    return withNameCols(build(best ?? two.placements, two.fontSize, two.cellPadding), two.nameCols);
  }

  // ── 3: unreachable safety — floor config, N pages, oversize own page ──
  const floorFont = levers.fontSizes[levers.fontSizes.length - 1];
  const floorPad = levers.cellPaddings[levers.cellPaddings.length - 1];
  const nameCols = new Map<string, number>(sections.map((s) => [s.id, capFor(s)]));
  const items = itemsFor(nameCols, floorFont, floorPad);
  const packed =
    packBins(items, geo.usableWidth, geo.heightBudget, geo.colGap, geo.rowGap, Number.POSITIVE_INFINITY, true) ?? [];
  const res = build(packed, floorFont, floorPad);
  res.overflow = true;
  return withNameCols(res, nameCols);
}
