/**
 * Gantt UI Bridge - Transforms schedule data into a format suitable
 * for rendering a Gantt-style timeline view.
 */
import { Schedule, GanttData } from '../models/types';
/**
 * Convert a Schedule into GanttData for rendering.
 */
export declare function scheduleToGantt(schedule: Schedule): GanttData;
/**
 * Generate ASCII representation of the Gantt chart for console output.
 */
export declare function ganttToAscii(data: GanttData, widthChars?: number): string;
/**
 * Export GanttData as a JSON string for consumption by web frameworks.
 */
export declare function exportGanttJson(data: GanttData): string;
/**
 * Build a task summary table from schedule data.
 */
export declare function buildTaskSummary(schedule: Schedule): string;
//# sourceMappingURL=gantt-bridge.d.ts.map