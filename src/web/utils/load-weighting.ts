import type { LoadWindow, Task } from '../../models/types';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function getTaskBaseLoadWeight(task: Task): number {
  if (task.isLight) return 0;
  return clamp01(task.baseLoadWeight ?? 1);
}

/**
 * Return the effective load weight at a specific instant within a task.
 *
 * - If `time` is outside the task's timeBlock, returns 0.
 * - If the task has loadWindows, returns the window weight if `time` falls
 *   inside a hot window, otherwise the baseLoadWeight.
 * - If no loadWindows, returns the baseLoadWeight (1.0 for heavy, 0 for light).
 *
 * This is used by the "No Consecutive High-Load" constraint (HC-12) to
 * determine whether the start/end boundary of a task is at high intensity.
 */
export function getLoadWeightAtTime(task: Task, time: Date): number {
  const t = time.getTime();
  const tStart = task.timeBlock.start.getTime();
  const tEnd = task.timeBlock.end.getTime();

  // Outside the task → weight 0
  // C2: Use half-open interval [start, end) — the exact end instant is
  // outside the task duration, consistent with standard scheduling semantics.
  if (t < tStart || t >= tEnd) return 0;

  if (task.isLight) return 0;

  const windows = task.loadWindows ?? [];
  const baseWeight = clamp01(task.baseLoadWeight ?? 1);

  // No load windows → uniform weight across the task
  if (windows.length === 0) return baseWeight;

  // Check if the instant falls inside any hot window
  for (const w of windows) {
    if (isTimeInsideWindow(time, w)) {
      return clamp01(w.weight);
    }
  }

  // Outside all hot windows → base (cold) weight
  return baseWeight;
}

/**
 * Check whether a specific instant falls inside a LoadWindow.
 *
 * C3: Uses calendar-absolute comparison instead of clock-of-day
 * matching, so the result is correct for the actual calendar day the
 * instant falls on (including midnight-crossing windows).
 */
function isTimeInsideWindow(time: Date, window: LoadWindow): boolean {
  // Build the window boundaries on the same calendar day as `time`
  const dayStart = new Date(time.getFullYear(), time.getMonth(), time.getDate());

  const wStartMs = new Date(
    dayStart.getFullYear(),
    dayStart.getMonth(),
    dayStart.getDate(),
    window.startHour,
    window.startMinute,
    0,
    0,
  ).getTime();

  const crossesMidnight =
    window.endHour < window.startHour ||
    (window.endHour === window.startHour && window.endMinute <= window.startMinute);

  const wEndMs = new Date(
    dayStart.getFullYear(),
    dayStart.getMonth(),
    dayStart.getDate() + (crossesMidnight ? 1 : 0),
    window.endHour,
    window.endMinute,
    0,
    0,
  ).getTime();

  const t = time.getTime();

  // Half-open interval [wStart, wEnd)
  if (t >= wStartMs && t < wEndMs) return true;

  // For midnight-crossing windows, also check the previous day's occurrence
  if (crossesMidnight) {
    const prevStart = wStartMs - 86_400_000; // −24h
    const prevEnd = wEndMs - 86_400_000;
    if (t >= prevStart && t < prevEnd) return true;
  }

  return false;
}

/**
 * Determine whether a task is at high-load (weight ≥ 1.0) at its start or end boundary.
 *
 * Used by HC-12: "No Consecutive High-Load Tasks". Two distinct back-to-back
 * tasks violate the constraint only if the first task ENDS at high load AND
 * the next task STARTS at high load.
 *
 * C2: With half-open intervals [start, end), the exact end instant is outside
 * the task. For the 'end' edge we evaluate at 1ms before end to check the
 * trailing load of the task.
 *
 * Results are memoized per task in WeakMaps — tasks are immutable objects
 * so the boundary load never changes.
 */
const _highLoadStartCache = new WeakMap<Task, boolean>();
const _highLoadEndCache = new WeakMap<Task, boolean>();

export function isHighLoadAtBoundary(task: Task, edge: 'start' | 'end'): boolean {
  const cache = edge === 'start' ? _highLoadStartCache : _highLoadEndCache;
  const cached = cache.get(task);
  if (cached !== undefined) return cached;

  const time = edge === 'start' ? task.timeBlock.start : new Date(task.timeBlock.end.getTime() - 1);
  const weight = getLoadWeightAtTime(task, time);
  const result = weight >= 1.0;
  cache.set(task, result);
  return result;
}

function overlapHours(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, (end - start) / 3600000);
}

function dayStartOf(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function computeWindowOverlapHours(task: Task, window: LoadWindow): number {
  const taskStart = task.timeBlock.start;
  const taskEnd = task.timeBlock.end;

  const firstDay = dayStartOf(new Date(taskStart.getTime() - 24 * 3600000));
  const lastDay = dayStartOf(taskEnd);

  let total = 0;
  const cursor = new Date(firstDay);

  while (cursor.getTime() <= lastDay.getTime()) {
    const wStart = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate(),
      window.startHour,
      window.startMinute,
      0,
      0,
    );
    const crossesMidnight =
      window.endHour < window.startHour ||
      (window.endHour === window.startHour && window.endMinute <= window.startMinute);

    const wEnd = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + (crossesMidnight ? 1 : 0),
      window.endHour,
      window.endMinute,
      0,
      0,
    );

    total += overlapHours(taskStart, taskEnd, wStart, wEnd);
    cursor.setDate(cursor.getDate() + 1);
  }

  return total;
}

/**
 * WeakMap cache for computeTaskEffectiveHours — the result depends only on
 * immutable task properties (timeBlock, loadWindows, baseLoadWeight, isLight)
 * so it is safe to cache by object identity.
 */
const _effectiveHoursCache = new WeakMap<Task, number>();

export function computeTaskEffectiveHours(task: Task): number {
  const cached = _effectiveHoursCache.get(task);
  if (cached !== undefined) return cached;

  if (task.isLight) {
    _effectiveHoursCache.set(task, 0);
    return 0;
  }

  const durationHours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
  if (durationHours <= 0) {
    _effectiveHoursCache.set(task, 0);
    return 0;
  }

  const baseWeight = getTaskBaseLoadWeight(task);
  const windows = task.loadWindows ?? [];
  if (windows.length === 0) {
    const result = durationHours * baseWeight;
    _effectiveHoursCache.set(task, result);
    return result;
  }

  // ── Accumulate window (hot) hours and their weighted contribution ──
  let hotHours = 0;
  let hotWeightedHours = 0;
  for (const window of windows) {
    const overlap = computeWindowOverlapHours(task, window);
    if (overlap <= 0) continue;
    const w = clamp01(window.weight);
    hotHours += overlap;
    hotWeightedHours += overlap * w;
  }

  // If windows overlap each other, cap at the task duration and scale
  // the weighted contribution proportionally to avoid double-counting.
  if (hotHours > durationHours) {
    const scale = durationHours / hotHours;
    hotWeightedHours *= scale;
    hotHours = durationHours;
  }

  // Cold hours = portion of the task NOT inside any hot window
  const coldHours = durationHours - hotHours;
  const effective = coldHours * baseWeight + hotWeightedHours;

  const result = Math.max(0, effective);
  _effectiveHoursCache.set(task, result);
  return result;
}

/**
 * Return hours counted at 100% load ("Hot Time").
 *
 * - Non-Kruv heavy tasks (no loadWindows, baseLoadWeight=1): entire duration is hot.
 * - Kruv tasks (loadWindows defined): only the window-overlap portion is hot.
 * - Karovit (isLight): 0.
 */
export function computeTaskHotHours(task: Task): number {
  if (task.isLight) return 0;

  const durationHours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
  if (durationHours <= 0) return 0;

  const windows = task.loadWindows ?? [];

  // No load-windows → all hours are hot (standard heavy task)
  if (windows.length === 0) return durationHours;

  // Has load-windows → only the overlap with hot windows is hot
  let hotHours = 0;
  for (const window of windows) {
    hotHours += computeWindowOverlapHours(task, window);
  }
  return Math.min(hotHours, durationHours);
}

/**
 * Return hours counted at the reduced base weight ("Cold Time").
 *
 * Only Kruv-style tasks (with loadWindows and baseLoadWeight < 1) produce cold hours.
 * Non-Kruv heavy tasks have 0 cold hours (they're 100% hot).
 * Karovit (isLight): 0.
 */
export function computeTaskColdHours(task: Task): number {
  if (task.isLight) return 0;
  const windows = task.loadWindows ?? [];
  if (windows.length === 0) return 0; // standard heavy task — all hot, no cold

  const durationHours = (task.timeBlock.end.getTime() - task.timeBlock.start.getTime()) / 3600000;
  if (durationHours <= 0) return 0;

  const hotHours = computeTaskHotHours(task);
  return Math.max(0, durationHours - hotHours);
}
