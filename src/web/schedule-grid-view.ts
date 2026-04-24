import { addDays } from 'date-fns';
import { type LiveModeState, type Schedule, Task } from '../models/types';
import { type ManualBuildRenderCtx, renderScheduleGridV2 } from './layout-engine';

// ─── Main View Export ────────────────────────────────────────────────────────

export function renderScheduleGrid(
  schedule: Schedule,
  currentDay: number,
  liveMode: LiveModeState,
  manualCtx?: ManualBuildRenderCtx,
  dayStartHour: number = 5,
): string {
  if (schedule.tasks.length === 0) return '<div class="alert alert-info">אין משימות בשבצ"ק.</div>';

  // Anchor on the frozen schedule.periodStart + dayStartHour — matches the
  // engine's op-day grouping and the canonical getDayWindow used by exports.
  const base = schedule.periodStart;
  const dayStart = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + currentDay - 1,
    dayStartHour,
    0,
    0,
    0,
  );
  const dayEnd = addDays(dayStart, 1);

  const startTimeNum = dayStart.getTime();
  const endTimeNum = dayEnd.getTime();

  const dayTasks = schedule.tasks.filter((t) => {
    const s = new Date(t.timeBlock.start).getTime();
    return s >= startTimeNum && s < endTimeNum;
  });

  if (dayTasks.length === 0) return '<div class="alert alert-info">אין משימות ביום זה.</div>';

  // Delegate to the smart layout engine
  return renderScheduleGridV2(dayTasks, schedule, liveMode, manualCtx);
}
