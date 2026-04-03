
import {
  Schedule,
  Task,
  LiveModeState
} from '../models/types';
import { addDays } from 'date-fns';
import {
  renderScheduleGridV2,
  ManualBuildRenderCtx,
} from './layout-engine';

// ─── Main View Export ────────────────────────────────────────────────────────

export function renderScheduleGrid(schedule: Schedule, currentDay: number, liveMode: LiveModeState, manualCtx?: ManualBuildRenderCtx): string {
    if (schedule.tasks.length === 0) return '<div class="alert alert-info">אין משימות בשבצ"ק.</div>';

    // 1. Calculate Day Range
    const allStarts = schedule.tasks.map(t => new Date(t.timeBlock.start).getTime());
    const minStart = Math.min(...allStarts);
    const scheduleStart = new Date(minStart);

    const dayAnchor = addDays(scheduleStart, currentDay - 1);

    const dayStart = new Date(dayAnchor);
    if (dayStart.getHours() < 5) {
        dayStart.setDate(dayStart.getDate() - 1);
    }
    dayStart.setHours(5, 0, 0, 0);
    const dayEnd = addDays(dayStart, 1);

    const startTimeNum = dayStart.getTime();
    const endTimeNum = dayEnd.getTime();

    const dayTasks = schedule.tasks.filter(t => {
        const s = new Date(t.timeBlock.start).getTime();
        return s >= startTimeNum && s < endTimeNum;
    });

    if (dayTasks.length === 0) return '<div class="alert alert-info">אין משימות ביום זה.</div>';

    // 2. Delegate to the smart layout engine
    return renderScheduleGridV2(dayTasks, schedule, liveMode, manualCtx);
}
