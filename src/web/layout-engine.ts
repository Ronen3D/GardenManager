/**
 * Smart Layout Engine for the Schedule Board ("תצוגת שבצ"ק").
 *
 * Replaces the hardcoded 5-category grid with a content-aware algorithm that
 * inspects each day's actual schedule structure and computes an optimal grid
 * composition using balanced row-packing with proportional widths.
 *
 * The layout is driven by structural properties (column count, row count,
 * slot density) — not by fixed task-type identities.
 */

import {
  Task,
  Schedule,
  Assignment,
  Participant,
  SlotRequirement,
  LiveModeState,
  AssignmentStatus,
} from '../models/types';
import { groupColor, fmt, SVG_ICONS, escHtml, levelBadge, certBadges } from './ui-helpers';

// ─── Manual Build Context ──────────────────────────────────────────────────

export interface ManualBuildRenderCtx {
  active: boolean;
  selectedTaskId?: string;
  selectedSlotId?: string;
}
import { getDisplayOrderMap, getCategoryColorMap } from './config-store';
import { isFutureTask } from '../engine/temporal';

// ─── Shared Helpers (canonical definitions — re-exported by schedule-grid-view) ─

export function getUniqueStartTimes(tasks: Task[]): number[] {
  const times = new Set<number>();
  tasks.forEach(t => times.add(new Date(t.timeBlock.start).getTime()));
  return Array.from(times).sort((a, b) => a - b);
}

export interface AssignedSlot {
  assignment?: Assignment;
  participant?: Participant;
  slot: SlotRequirement;
}

export function getTaskAssignments(task: Task, schedule: Schedule): AssignedSlot[] {
  const taskAssignments = schedule.assignments.filter(a => a.taskId === task.id);
  const participantMap = new Map(schedule.participants.map(p => [p.id, p]));
  return task.slots.map(slot => {
    const assign = taskAssignments.find(a => a.slotId === slot.slotId);
    return {
      slot,
      assignment: assign,
      participant: assign ? participantMap.get(assign.participantId) : undefined
    };
  });
}

// ─── Configuration Constants ────────────────────────────────────────────────

/** Maximum sections placed side-by-side in a single grid row. */
const MAX_SECTIONS_PER_ROW = 3;

/** Minimum column span (out of 12) a section can receive. Prevents unreadable narrow sections. */
const MIN_COL_SPAN = 3;

/** Total grid units (like Bootstrap's 12-column grid). */
const GRID_UNITS = 12;

/** A section with weight exceeding this fraction of total weight gets its own full-width row. */
const FULL_WIDTH_THRESHOLD = 0.5;

/** Display order for custom/unknown categories. */
const CUSTOM_DISPLAY_ORDER = 100;

/** Resolve display order for a category from config-store templates. */
function resolveDisplayOrder(cat: string): number {
  return getDisplayOrderMap()[cat] ?? CUSTOM_DISPLAY_ORDER;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SectionMetrics {
  id: string;             // displayCategory value
  title: string;          // human-readable label
  tasks: Task[];
  columnCount: number;    // data columns the table needs
  rowCount: number;       // unique start times
  totalSlots: number;     // sum of all slot requirements
  maxSlotsPerCell: number;
  weight: number;         // computed layout weight
  displayOrder: number;   // sort priority
  wrapperClass: string;   // CSS class for type-specific tinting
}

export interface ColumnDefinition {
  key: string;
  header: string;
  /** Given a task and its assigned slots, return the slots that belong to this column. */
  matchSlots: (task: Task, slots: AssignedSlot[]) => AssignedSlot[];
}

type ColumnStrategy = (tasks: Task[]) => ColumnDefinition[];

interface LayoutRow {
  sections: SectionMetrics[];
  totalWeight: number;
}

export interface SectionPlacement {
  sectionId: string;
  row: number;       // 1-indexed grid row
  colStart: number;  // 1-indexed grid column start
  colSpan: number;   // number of grid units to span
}

export interface GridTemplate {
  gridTemplateColumns: string;
  totalRows: number;
  placements: SectionPlacement[];
}

// ─── Display Category Helper ────────────────────────────────────────────────

function getDisplayCategory(task: Task): string {
  if (task.displayCategory) return task.displayCategory;
  return (task.sourceName || task.name || 'custom').toLowerCase();
}

// ─── Wrapper class for type-specific tinting ────────────────────────────────

/** Compute wrapper CSS class from category name. Convention: `${category}-wrapper`. */
function resolveWrapperClass(cat: string): string {
  return cat ? `${cat}-wrapper` : '';
}

// ─── Column Strategies ──────────────────────────────────────────────────────

/**
 * Flat strategy: all slots rendered in a single column.
 * Used for simple sections like hamama, mamtera, or custom categories.
 */
function flatStrategy(tasks: Task[]): ColumnDefinition[] {
  const sourceNames = [...new Set(tasks.map(t => t.sourceName || t.name))];
  const header = sourceNames.join(', ');

  return [{
    key: 'all',
    header,
    matchSlots: (_task: Task, slots: AssignedSlot[]) => slots,
  }];
}

/**
 * Sub-team strategy: one column per unique subTeamId.
 * Used for sections like aruga and shemesh where slots carry subTeamId.
 */
function subTeamStrategy(tasks: Task[]): ColumnDefinition[] {
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

  // Derive section label from source name
  const categoryLabel = tasks[0].sourceName || tasks[0].name;

  return subTeamIds.map((stId, i) => {
    // Try to find a human-readable name from the first matching slot
    let label: string | undefined;
    for (const t of tasks) {
      const sample = t.slots.find(s => (s.subTeamId ?? '') === stId);
      if (sample?.label) { label = sample.label; break; }
    }
    if (!label) {
      label = subTeamIds.length === 1 ? categoryLabel : `${categoryLabel} #${subTeamIds.length - i}`;
    }

    return {
      key: `subteam-${stId || i}`,
      header: label,
      matchSlots: (_task: Task, slots: AssignedSlot[]) =>
        slots.filter(s => (s.slot.subTeamId ?? '') === stId),
    };
  });
}

/**
 * Multi-source split strategy: columns for sub-team IDs + one column per
 * non-team source name. Used for sections combining team-based tasks
 * with other source types.
 */
function multiSourceSplitStrategy(tasks: Task[]): ColumnDefinition[] {
  const columns: ColumnDefinition[] = [];

  // Collect all slots once for ID extraction and label lookup
  const allSlots = tasks.flatMap(t => t.slots);
  const distinctTeamIds = [...new Set(
    allSlots.map(s => s.subTeamId).filter(Boolean)
  )] as string[];
  distinctTeamIds.sort();

  // Group non-team tasks by sourceName → one column per source
  const nonTeamSources: string[] = [];
  const nonTeamBySource = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.slots.some(s => s.subTeamId != null)) {
      const key = t.sourceName || t.name;
      if (!nonTeamBySource.has(key)) {
        nonTeamSources.push(key);
        nonTeamBySource.set(key, []);
      }
      nonTeamBySource.get(key)!.push(t);
    }
  }

  // Team columns first (they appear on the right in RTL)
  for (const teamId of distinctTeamIds) {
    const label = allSlots.find(s => s.subTeamId === teamId)?.subTeamLabel ?? teamId;
    columns.push({
      key: `team-${teamId}`,
      header: label,
      matchSlots: (_task: Task, slots: AssignedSlot[]) =>
        slots.filter(s => s.slot.subTeamId === teamId),
    });
  }

  // Non-team source columns
  for (const sourceKey of nonTeamSources) {
    columns.push({
      key: `source-${sourceKey}`,
      header: sourceKey,
      matchSlots: (task: Task, slots: AssignedSlot[]) =>
        (task.sourceName || task.name) === sourceKey && !task.slots.some(s => s.subTeamId != null) ? slots : [],
    });
  }

  return columns;
}

/**
 * Infer the best column strategy for a set of tasks based on their slot properties.
 */
function inferColumnStrategy(tasks: Task[]): ColumnStrategy {
  const hasTeams = tasks.some(t => t.slots.some(s => s.subTeamId != null));
  const hasMultipleSources = new Set(tasks.map(t => t.sourceName || t.name)).size > 1;

  if (hasTeams || hasMultipleSources) return multiSourceSplitStrategy;

  const hasSubTeams = tasks.some(t => t.slots.some(s => s.subTeamId));
  if (hasSubTeams) return subTeamStrategy;

  return flatStrategy;
}

// ─── Section Metrics Computation ────────────────────────────────────────────

/**
 * Compute structural metrics for each display-category section present in the
 * given tasks. These metrics drive all layout decisions.
 */
export function computeSectionMetrics(dayTasks: Task[]): SectionMetrics[] {
  // Group tasks by display category
  const groups = new Map<string, Task[]>();
  for (const t of dayTasks) {
    const cat = getDisplayCategory(t);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(t);
  }

  const sections: SectionMetrics[] = [];

  for (const [cat, tasks] of groups) {
    const strategy = inferColumnStrategy(tasks);
    const columns = strategy(tasks);
    const columnCount = columns.length;
    const uniqueTimes = getUniqueStartTimes(tasks);
    const rowCount = uniqueTimes.length;
    const totalSlots = tasks.reduce((sum, t) => sum + t.slots.length, 0);

    // Compute max slots per cell: for each time × column, how many cards are there?
    let maxSlotsPerCell = 0;
    for (const timeNum of uniqueTimes) {
      const timeTasks = tasks.filter(t => new Date(t.timeBlock.start).getTime() === timeNum);
      for (const col of columns) {
        let cellSlots = 0;
        for (const task of timeTasks) {
          // Count slots that match this column (without needing full assignment resolution)
          const matchCount = task.slots.filter(s => {
            // Simulate matchSlots logic based on column key
            if (col.key === 'all') return true;
            if (col.key.startsWith('subteam-')) {
              const stId = col.key.replace('subteam-', '');
              return (s.subTeamId ?? '') === stId || (s.subTeamId == null && stId === '0');
            }
            if (col.key.startsWith('team-')) {
              return s.subTeamId === col.key.replace('team-', '');
            }
            if (col.key.startsWith('source-')) {
              const sourceKey = col.key.replace('source-', '');
              return (task.sourceName || task.name) === sourceKey && s.subTeamId == null;
            }
            return true;
          }).length;
          cellSlots += matchCount;
        }
        maxSlotsPerCell = Math.max(maxSlotsPerCell, cellSlots);
      }
    }

    // Weight formula: cell area + density bonus
    const weight = Math.max(1, columnCount * rowCount + totalSlots * 0.25);

    // Build title from task source names present
    const sourceNames = [...new Set(tasks.map(t => t.sourceName || t.name))];
    const title = sourceNames.filter(Boolean).join(' ו');

    sections.push({
      id: cat,
      title,
      tasks,
      columnCount,
      rowCount,
      totalSlots,
      maxSlotsPerCell,
      weight,
      displayOrder: resolveDisplayOrder(cat),
      wrapperClass: resolveWrapperClass(cat),
    });
  }

  // Sort by display order for consistent ordering
  sections.sort((a, b) => a.displayOrder - b.displayOrder);
  return sections;
}

// ─── Row Assignment (Balanced Bin Packing) ──────────────────────────────────

/**
 * Assign sections to grid rows using balanced bin-packing.
 *
 * Heaviest sections are placed first. A section that exceeds FULL_WIDTH_THRESHOLD
 * of total weight gets its own dedicated row. Otherwise, sections are placed into
 * the row with the smallest total weight that still has room.
 */
export function assignRows(sections: SectionMetrics[]): LayoutRow[] {
  if (sections.length === 0) return [];
  if (sections.length === 1) return [{ sections: [sections[0]], totalWeight: sections[0].weight }];

  const totalWeight = sections.reduce((sum, s) => sum + s.weight, 0);

  // Sort by weight descending for greedy placement
  const sorted = [...sections].sort((a, b) => b.weight - a.weight);

  // Determine target row count
  const targetRows = Math.min(4, Math.max(1, Math.ceil(sorted.length / MAX_SECTIONS_PER_ROW)));

  const rows: LayoutRow[] = Array.from({ length: targetRows }, () => ({
    sections: [],
    totalWeight: 0,
  }));

  for (const section of sorted) {
    // Full-width promotion: section dominates the schedule
    if (section.weight > totalWeight * FULL_WIDTH_THRESHOLD && sorted.length > 1) {
      // Insert a dedicated row at position 0 (or after other promoted rows)
      const insertIdx = rows.findIndex(r => r.sections.length === 0);
      if (insertIdx >= 0) {
        rows[insertIdx].sections.push(section);
        rows[insertIdx].totalWeight = section.weight;
      } else {
        rows.unshift({ sections: [section], totalWeight: section.weight });
      }
      continue;
    }

    // Find the row with smallest total weight that has room
    let bestRow: LayoutRow | null = null;
    for (const row of rows) {
      if (row.sections.length < MAX_SECTIONS_PER_ROW) {
        if (!bestRow || row.totalWeight < bestRow.totalWeight) {
          bestRow = row;
        }
      }
    }

    if (bestRow) {
      bestRow.sections.push(section);
      bestRow.totalWeight += section.weight;
    } else {
      // All rows full — add a new row
      rows.push({ sections: [section], totalWeight: section.weight });
    }
  }

  // Remove empty rows
  const nonEmpty = rows.filter(r => r.sections.length > 0);

  // Within each row, sort sections by display order for consistent visual positioning
  for (const row of nonEmpty) {
    row.sections.sort((a, b) => a.displayOrder - b.displayOrder);
  }

  return nonEmpty;
}

// ─── Grid Template Generation ───────────────────────────────────────────────

/**
 * Generate CSS Grid placement instructions from the row assignments.
 * Uses a 12-unit grid where each section gets a proportional span.
 */
export function generateGridTemplate(rows: LayoutRow[]): GridTemplate {
  if (rows.length === 0) {
    return { gridTemplateColumns: `repeat(${GRID_UNITS}, 1fr)`, totalRows: 0, placements: [] };
  }

  const placements: SectionPlacement[] = [];

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];

    if (row.sections.length === 1) {
      // Single section in row → full width
      placements.push({
        sectionId: row.sections[0].id,
        row: rowIdx + 1,
        colStart: 1,
        colSpan: GRID_UNITS,
      });
      continue;
    }

    // Compute proportional spans
    const rawSpans = row.sections.map(s =>
      Math.max(MIN_COL_SPAN, Math.round((s.weight / row.totalWeight) * GRID_UNITS))
    );

    // Adjust to sum exactly to GRID_UNITS
    let sum = rawSpans.reduce((a, b) => a + b, 0);
    while (sum !== GRID_UNITS) {
      if (sum < GRID_UNITS) {
        // Give extra to the heaviest section (index 0 after sorting, but find the max-weight one)
        const maxIdx = rawSpans.reduce((best, val, i) =>
          row.sections[i].weight > row.sections[best].weight ? i : best, 0);
        rawSpans[maxIdx]++;
        sum++;
      } else {
        // Take from the lightest section that is above minimum
        let minIdx = -1;
        let minWeight = Infinity;
        for (let i = 0; i < rawSpans.length; i++) {
          if (rawSpans[i] > MIN_COL_SPAN && row.sections[i].weight < minWeight) {
            minWeight = row.sections[i].weight;
            minIdx = i;
          }
        }
        if (minIdx >= 0) {
          rawSpans[minIdx]--;
          sum--;
        } else {
          break; // Can't reduce further without going below minimum
        }
      }
    }

    // Place sections left-to-right (CSS grid handles RTL via direction)
    let colCursor = 1;
    for (let i = 0; i < row.sections.length; i++) {
      placements.push({
        sectionId: row.sections[i].id,
        row: rowIdx + 1,
        colStart: colCursor,
        colSpan: rawSpans[i],
      });
      colCursor += rawSpans[i];
    }
  }

  return {
    gridTemplateColumns: `repeat(${GRID_UNITS}, 1fr)`,
    totalRows: rows.length,
    placements,
  };
}

// ─── Card Renderer ──────────────────────────────────────────────────────────

function renderAssignmentCard(
  slot: SlotRequirement,
  assignment: Assignment | undefined,
  participant: Participant | undefined,
  task: Task,
  liveMode: LiveModeState,
  manualCtx?: ManualBuildRenderCtx,
): string {
  const isFuture = isFutureTask(task, liveMode.currentTimestamp);
  const isFrozen = liveMode.enabled && !isFuture;
  const isLocked = assignment?.status === AssignmentStatus.Locked || assignment?.status === AssignmentStatus.Manual;
  const isConflict = assignment?.status === AssignmentStatus.Conflict;
  const isManualActive = manualCtx?.active === true;
  const isSelected = isManualActive && manualCtx.selectedTaskId === task.id && manualCtx.selectedSlotId === slot.slotId;

  let cardClass = 'assignment-card';
  if (isConflict) cardClass += ' status-conflict';
  else if (isFrozen) cardClass += ' status-frozen';
  else if (isLocked) cardClass += ' status-locked';

  // Manual-build mode classes
  if (isManualActive) {
    cardClass += ' manual-slot-target';
    if (isSelected) cardClass += ' manual-slot-selected';
    if (!participant) cardClass += ' manual-slot-empty';
  }

  const dataAttrs = assignment
    ? `data-assignment-id="${assignment.id}" data-task-id="${task.id}" data-slot-id="${slot.slotId}"`
    : `data-slot-id="${slot.slotId}" data-task-id="${task.id}"`;

  let content = '';

  if (participant) {
    const hoverAttrs = assignment
      ? `data-pid="${participant.id}" data-assignment-id="${assignment.id}" data-task-id="${task.id}"${isFrozen ? ' data-frozen="1"' : ''}${isLocked ? ' data-locked="1"' : ''}`
      : `data-pid="${participant.id}"`;

    content = `
      <div class="card-header">
        <span class="participant-name ${isManualActive ? '' : 'participant-hover'}" role="button" tabindex="0" ${hoverAttrs} style="color:${groupColor(participant.group)}">
          ${escHtml(participant.name)}
        </span>
      </div>
      <div class="card-details">
        ${isLocked ? '<span title="נעל">🔒</span>' : ''}
        ${isFrozen ? `<span title="מוקפא">${SVG_ICONS.snowflake}</span>` : ''}
        ${isSelected && isManualActive && !isFrozen ? '<button class="btn-manual-remove" data-action="manual-remove" title="הסר שיבוץ">✕ הסר</button>' : ''}
      </div>
    `;
  } else {
    // Empty slot: show label + hints in manual-build mode
    let slotHint = '';
    if (isManualActive) {
      const levels = slot.acceptableLevels.map(l => l.level).join('/');
      const certs = slot.requiredCertifications;
      slotHint = `<div class="manual-slot-hint">${levels ? `L${levels}` : ''}${certs.length ? ' ' + certBadges(certs, '') : ''}</div>`;
    }
    content = `<div class="empty-slot-label">${escHtml(slot.label || task.name)}</div>${slotHint}`;
  }

  return `
    <div class="${cardClass}" ${dataAttrs}>
      ${content}
    </div>
  `;
}

function renderTimeCell(time: Date, timeNum: number): string {
  return `<td class="time-cell time-cell-inspectable" data-time-ms="${timeNum}" role="button" tabindex="0" title="הצג זמינות לפי פק\"ל">${fmt(time)}</td>`;
}

// ─── Unified Section Table Renderer ─────────────────────────────────────────

/**
 * Render a single section's table. Replaces the 6 dedicated renderer functions
 * with a single data-driven renderer that auto-selects column strategy.
 */
export function renderSectionTable(
  section: SectionMetrics,
  schedule: Schedule,
  liveMode: LiveModeState,
  manualCtx?: ManualBuildRenderCtx,
): string {
  if (section.tasks.length === 0) return '';

  const strategy = inferColumnStrategy(section.tasks);
  const columns = strategy(section.tasks);
  const uniqueTimes = getUniqueStartTimes(section.tasks);

  const rows = uniqueTimes.map(timeNum => {
    const time = new Date(timeNum);
    const timeTasks = section.tasks.filter(t =>
      new Date(t.timeBlock.start).getTime() === timeNum
    );

    const cells = columns.map(col => {
      const cellCards = timeTasks.flatMap(task => {
        const allSlots = getTaskAssignments(task, schedule);
        const matched = col.matchSlots(task, allSlots);
        return matched.map(s =>
          renderAssignmentCard(s.slot, s.assignment, s.participant, task, liveMode, manualCtx)
        );
      });
      return `<td class="task-cell">${cellCards.join('')}</td>`;
    });

    // Skip rows where all data cells are empty
    if (cells.every(c => c === '<td class="task-cell"></td>')) return '';

    return `
      <tr data-time="${timeNum}">
        ${renderTimeCell(time, timeNum)}
        ${cells.join('')}
      </tr>
    `;
  }).join('');

  const headerCells = columns.map(c => `<th>${c.header}</th>`).join('');
  const wrapperClass = section.wrapperClass
    ? `schedule-table-wrapper ${section.wrapperClass}`
    : 'schedule-table-wrapper';

  // Resolve section color for CSS variable tinting
  const catColors = getCategoryColorMap();
  const sectionColor = catColors[section.id] || '#999';

  return `
    <div class="${wrapperClass}" data-section="${section.id}" data-columns="${columns.length}" style="--section-color: ${sectionColor}; --col-count: ${columns.length}">
      <h3 class="table-title">${section.title}</h3>
      <table class="table schedule-grid-table">
        <thead><tr><th class="col-time">זמן</th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ─── Main Entry: Render Full Grid ───────────────────────────────────────────

/**
 * Render the complete schedule grid for a given day using the smart layout engine.
 * This is the V2 replacement for the original renderScheduleGrid().
 */
export function renderScheduleGridV2(
  dayTasks: Task[],
  schedule: Schedule,
  liveMode: LiveModeState,
  manualCtx?: ManualBuildRenderCtx,
): string {
  if (dayTasks.length === 0) return '';

  // 1. Compute section metrics from actual content
  const sections = computeSectionMetrics(dayTasks);
  if (sections.length === 0) return '';

  // 2. Assign sections to rows using balanced bin-packing
  const rows = assignRows(sections);

  // 3. Generate CSS Grid placement
  const template = generateGridTemplate(rows);

  // 4. Build placement map for quick lookup
  const placementMap = new Map(template.placements.map(p => [p.sectionId, p]));

  // 5. Render each section table with inline grid placement
  const sectionHtml = sections.map(section => {
    const placement = placementMap.get(section.id);
    if (!placement) return '';

    const gridStyle = `grid-row: ${placement.row}; grid-column: ${placement.colStart} / span ${placement.colSpan};`;
    const tableHtml = renderSectionTable(section, schedule, liveMode, manualCtx);
    if (!tableHtml) return '';

    return `<div style="${gridStyle}">${tableHtml}</div>`;
  }).join('');

  return `
    <div class="schedule-grid-container schedule-grid-smart${manualCtx?.active ? ' schedule-grid-compact' : ''}">
      ${sectionHtml}
    </div>
  `;
}
