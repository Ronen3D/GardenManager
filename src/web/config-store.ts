/**
 * Stage 0 Configuration Store
 *
 * In-memory reactive store for participants, task templates,
 * and blackout periods. Provides CRUD operations and change
 * notifications so UI can re-render on mutations.
 */

import {
  Participant,
  Level,
  Certification,
  TaskType,
  AdanitTeam,
  BlackoutPeriod,
  TaskTemplate,
  SlotTemplate,
  SubTeamTemplate,
  AvailabilityWindow,
  DateUnavailability,
  LiveModeState,
  Schedule,
  AlgorithmSettings,
  DEFAULT_ALGORITHM_SETTINGS,
  HardConstraintCode,
  SoftWarningCode,
  SchedulerConfig,
  AlgorithmPreset,
  DEFAULT_PRESET,
} from '../models/types';

// ─── ID Generation ───────────────────────────────────────────────────────────

let _idCounter = 0;
function uid(prefix: string): string {
  return `${prefix}-${++_idCounter}-${Date.now().toString(36)}`;
}

export { uid };

// ─── Listener System ─────────────────────────────────────────────────────────

type Listener = () => void;
const listeners: Set<Listener> = new Set();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch (_) { /* swallow */ }
  }
  // Auto-persist state to localStorage (debounced)
  debouncedSave();
}

// ─── Undo / Redo System ──────────────────────────────────────────────────────

interface StoreSnapshot {
  participants: Array<{ p: Participant; blackouts: BlackoutPeriod[]; dateUnavails: DateUnavailability[] }>;
  taskTemplates: TaskTemplate[];
}

const MAX_HISTORY = 80;
const undoStack: StoreSnapshot[] = [];
const redoStack: StoreSnapshot[] = [];
let _suppressSnapshot = false;

/**
 * Capture the current state as a deep-cloned snapshot.
 *
 * Uses structuredClone when available (all modern browsers & Node 17+)
 * for a single C++ pass instead of manually spreading every field.
 * Falls back to a manual clone only for environments that lack it.
 */
function captureSnapshot(): StoreSnapshot {
  const ps: StoreSnapshot['participants'] = [];
  for (const [id, p] of participants) {
    // Date objects survive structuredClone; avoid per-field spreading
    const clonedP = typeof structuredClone === 'function'
      ? structuredClone(p)
      : {
          ...p,
          certifications: [...p.certifications],
          availability: p.availability.map(w => ({ start: new Date(w.start.getTime()), end: new Date(w.end.getTime()) })),
          dateUnavailability: [...(p.dateUnavailability || [])].map(r => ({ ...r })),
        };
    const rawBouts = blackouts.get(id) || [];
    const rawDus = dateUnavailabilities.get(id) || [];
    ps.push({
      p: clonedP,
      blackouts: typeof structuredClone === 'function'
        ? structuredClone(rawBouts)
        : rawBouts.map(b => ({ ...b, start: new Date(b.start.getTime()), end: new Date(b.end.getTime()) })),
      dateUnavails: typeof structuredClone === 'function'
        ? structuredClone(rawDus)
        : rawDus.map(r => ({ ...r })),
    });
  }
  const tpls: TaskTemplate[] = typeof structuredClone === 'function'
    ? structuredClone([...taskTemplates.values()])
    : [...taskTemplates.values()].map(tpl => ({
        ...tpl,
        loadWindows: (tpl.loadWindows || []).map(w => ({ ...w })),
        slots: tpl.slots.map(s => ({ ...s, acceptableLevels: [...s.acceptableLevels], requiredCertifications: [...s.requiredCertifications] })),
        subTeams: tpl.subTeams.map(st => ({
          ...st,
          slots: st.slots.map(s => ({ ...s, acceptableLevels: [...s.acceptableLevels], requiredCertifications: [...s.requiredCertifications] })),
        })),
      }));
  return { participants: ps, taskTemplates: tpls };
}

/** Replace live state with a snapshot (restoring original IDs). */
function restoreSnapshot(snap: StoreSnapshot): void {
  participants.clear();
  blackouts.clear();
  dateUnavailabilities.clear();

  const useStructured = typeof structuredClone === 'function';

  for (const entry of snap.participants) {
    const p: Participant = useStructured
      ? structuredClone(entry.p)
      : {
          ...entry.p,
          certifications: [...entry.p.certifications],
          availability: entry.p.availability.map(w => ({ start: new Date(w.start.getTime()), end: new Date(w.end.getTime()) })),
          dateUnavailability: (entry.dateUnavails || []).map(r => ({ ...r })),
        };
    if (!useStructured) {
      p.dateUnavailability = (entry.dateUnavails || []).map(r => ({ ...r }));
    }
    participants.set(p.id, p);
    if (entry.blackouts.length > 0) {
      blackouts.set(p.id, useStructured
        ? structuredClone(entry.blackouts)
        : entry.blackouts.map(b => ({ ...b, start: new Date(b.start.getTime()), end: new Date(b.end.getTime()) })));
    }
    if (entry.dateUnavails && entry.dateUnavails.length > 0) {
      dateUnavailabilities.set(p.id, useStructured
        ? structuredClone(entry.dateUnavails)
        : entry.dateUnavails.map(r => ({ ...r })));
    }
  }

  // Bug #6 fix: ensure participant inline dateUnavailability shares the
  // same array reference as the dateUnavailabilities Map entry.
  for (const [id, p] of participants) {
    p.dateUnavailability = dateUnavailabilities.get(id) || [];
  }

  // Recompute availability from canonical data — the snapshot does not
  // capture scheduleDate/scheduleDays, so restored availability windows
  // may be stale relative to the current scheduling window.
  recalcAllAvailability();

  taskTemplates.clear();
  if (useStructured) {
    for (const tpl of snap.taskTemplates) {
      taskTemplates.set(tpl.id, structuredClone(tpl));
    }
  } else {
    for (const tpl of snap.taskTemplates) {
      taskTemplates.set(tpl.id, {
        ...tpl,
        loadWindows: (tpl.loadWindows || []).map(w => ({ ...w })),
        slots: tpl.slots.map(s => ({ ...s, acceptableLevels: [...s.acceptableLevels], requiredCertifications: [...s.requiredCertifications] })),
        subTeams: tpl.subTeams.map(st => ({
          ...st,
          slots: st.slots.map(s => ({ ...s, acceptableLevels: [...s.acceptableLevels], requiredCertifications: [...s.requiredCertifications] })),
        })),
      });
    }
  }
}

/**
 * Save current state to the undo stack before a mutation.
 * Called at the START of every mutating operation.
 */
function pushSnapshot(): void {
  if (_suppressSnapshot) return;
  undoStack.push(captureSnapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  // Any new mutation clears the redo future
  redoStack.length = 0;
}

/** Undo the last action. Returns true if successful. */
export function undo(): boolean {
  if (undoStack.length === 0) return false;
  // Save current state to redo before restoring
  redoStack.push(captureSnapshot());
  const snap = undoStack.pop()!;
  restoreSnapshot(snap);
  notify();
  return true;
}

/** Redo the last undone action. Returns true if successful. */
export function redo(): boolean {
  if (redoStack.length === 0) return false;
  // Save current state to undo before restoring
  undoStack.push(captureSnapshot());
  const snap = redoStack.pop()!;
  restoreSnapshot(snap);
  notify();
  return true;
}

/** Query undo/redo availability for UI button states. */
export function getUndoRedoState(): { canUndo: boolean; canRedo: boolean; undoDepth: number; redoDepth: number } {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoDepth: undoStack.length,
    redoDepth: redoStack.length,
  };
}

// ─── Participant Store ───────────────────────────────────────────────────────

const participants: Map<string, Participant> = new Map();
const blackouts: Map<string, BlackoutPeriod[]> = new Map(); // participantId -> blackouts
const dateUnavailabilities: Map<string, DateUnavailability[]> = new Map(); // participantId -> rules

/** Default scheduling window (7-day window starting from the configured date) */
let scheduleDate: Date = new Date(2026, 1, 15);
let scheduleDays: number = 7;

export function getScheduleDate(): Date { return scheduleDate; }
export function getScheduleDays(): number { return scheduleDays; }
export function setScheduleDate(d: Date): void {
  pushSnapshot();
  scheduleDate = d;
  recalcAllAvailability();
  notify();
}
export function setScheduleDays(n: number): void {
  pushSnapshot();
  scheduleDays = Math.max(1, Math.min(14, n));
  recalcAllAvailability();
  notify();
}

function getDefaultAvailability(): AvailabilityWindow[] {
  const d = scheduleDate;
  // Cover the full multi-day window plus buffer for overnight tasks
  return [{
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0),
    end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + scheduleDays, 12, 0),
  }];
}

function computeAvailability(participantId: string): AvailabilityWindow[] {
  const full = getDefaultAvailability();
  const bouts = blackouts.get(participantId) || [];
  const dateRules = dateUnavailabilities.get(participantId) || [];

  // Expand date-unavailability rules into concrete blackout-style windows
  const expandedBlackouts: Array<{ start: Date; end: Date }> = bouts.map(b => ({ start: b.start, end: b.end }));

  const schedStart = scheduleDate;
  for (const rule of dateRules) {
    for (let dayOff = 0; dayOff < scheduleDays; dayOff++) {
      const dayDate = new Date(schedStart.getFullYear(), schedStart.getMonth(), schedStart.getDate() + dayOff);
      let matches = false;

      if (rule.specificDate) {
        // Match by YYYY-MM-DD
        const iso = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, '0')}-${String(dayDate.getDate()).padStart(2, '0')}`;
        if (iso === rule.specificDate) matches = true;
      } else if (rule.dayOfWeek !== undefined) {
        if (dayDate.getDay() === rule.dayOfWeek) matches = true;
      }

      if (matches) {
        if (rule.allDay) {
          expandedBlackouts.push({
            start: new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 0, 0),
            end: new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate() + 1, 0, 0),
          });
        } else {
          let endH = rule.endHour;
          let endDay = dayDate.getDate();
          if (endH < rule.startHour) { endDay += 1; } // crosses midnight
          expandedBlackouts.push({
            start: new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), rule.startHour, 0),
            end: new Date(dayDate.getFullYear(), dayDate.getMonth(), endDay, endH, 0),
          });
        }
      }
    }
  }

  if (expandedBlackouts.length === 0) return full;

  // Subtract all blackout windows from the full availability
  let windows = [...full];
  for (const bout of expandedBlackouts) {
    const next: AvailabilityWindow[] = [];
    for (const w of windows) {
      if (bout.end <= w.start || bout.start >= w.end) {
        // No overlap
        next.push(w);
      } else {
        // Overlap — split
        if (bout.start > w.start) {
          next.push({ start: w.start, end: bout.start });
        }
        if (bout.end < w.end) {
          next.push({ start: bout.end, end: w.end });
        }
      }
    }
    windows = next;
  }
  return windows;
}

function recalcAllAvailability(): void {
  for (const [id, p] of participants) {
    p.availability = computeAvailability(id);
  }
}

export function addParticipant(data: {
  name: string; level?: Level;
  certifications?: Certification[]; group: string;
}): Participant {
  pushSnapshot();
  const id = uid('p');
  const p: Participant = {
    id,
    name: data.name,
    level: data.level ?? Level.L0,
    certifications: data.certifications ?? [Certification.Nitzan],
    group: data.group,
    availability: getDefaultAvailability(),
    dateUnavailability: [],
  };
  participants.set(id, p);
  notify();
  return p;
}

export function updateParticipant(id: string, patch: Partial<Omit<Participant, 'id' | 'availability'>>): void {
  const p = participants.get(id);
  if (!p) return;
  pushSnapshot();
  Object.assign(p, patch);
  p.availability = computeAvailability(id);
  notify();
}

export function removeParticipant(id: string): void {
  if (!participants.has(id)) return;
  pushSnapshot();
  participants.delete(id);
  blackouts.delete(id);
  dateUnavailabilities.delete(id);
  notify();
}

/**
 * Remove multiple participants and all their associated data in one
 * undo-able action.  Uses a Set for O(1) membership checks and deletes
 * participants, blackouts, and unavailability entries in a single pass.
 * Returns the number of participants actually removed.
 */
export function removeParticipantsBulk(ids: string[]): number {
  const removeSet = new Set(ids);
  const validIds: string[] = [];
  for (const id of removeSet) {
    if (participants.has(id)) validIds.push(id);
  }
  if (validIds.length === 0) return 0;
  pushSnapshot();
  for (const id of validIds) {
    participants.delete(id);
    blackouts.delete(id);
    dateUnavailabilities.delete(id);
  }
  notify();
  return validIds.length;
}

export function getParticipant(id: string): Participant | undefined {
  return participants.get(id);
}

export function getAllParticipants(): Participant[] {
  return [...participants.values()];
}

export function getGroups(): string[] {
  const groups = new Set<string>();
  for (const p of participants.values()) groups.add(p.group);
  return [...groups].sort();
}

// ─── Blackout Management ─────────────────────────────────────────────────────

export function addBlackout(participantId: string, start: Date, end: Date, reason?: string): BlackoutPeriod | null {
  if (!participants.has(participantId)) return null;
  pushSnapshot();
  const bout: BlackoutPeriod = { id: uid('bo'), start, end, reason };
  const arr = blackouts.get(participantId) || [];
  arr.push(bout);
  blackouts.set(participantId, arr);
  const p = participants.get(participantId)!;
  p.availability = computeAvailability(participantId);
  notify();
  return bout;
}

export function removeBlackout(participantId: string, blackoutId: string): void {
  const arr = blackouts.get(participantId);
  if (!arr) return;
  const idx = arr.findIndex(b => b.id === blackoutId);
  if (idx < 0) return;
  pushSnapshot();
  arr.splice(idx, 1);
  const p = participants.get(participantId);
  if (p) p.availability = computeAvailability(participantId);
  notify();
}

export function getBlackouts(participantId: string): BlackoutPeriod[] {
  return blackouts.get(participantId) || [];
}

// ─── Date Unavailability Management ──────────────────────────────────────────

export function addDateUnavailability(
  participantId: string,
  rule: Omit<DateUnavailability, 'id'>,
): DateUnavailability | null {
  if (!participants.has(participantId)) return null;
  pushSnapshot();
  const du: DateUnavailability = { ...rule, id: uid('du') };
  const arr = dateUnavailabilities.get(participantId) || [];
  arr.push(du);
  dateUnavailabilities.set(participantId, arr);
  const p = participants.get(participantId)!;
  p.dateUnavailability = arr;
  p.availability = computeAvailability(participantId);
  notify();
  return du;
}

export function removeDateUnavailability(participantId: string, ruleId: string): void {
  const arr = dateUnavailabilities.get(participantId);
  if (!arr) return;
  const idx = arr.findIndex(r => r.id === ruleId);
  if (idx < 0) return;
  pushSnapshot();
  arr.splice(idx, 1);
  const p = participants.get(participantId);
  if (p) {
    p.dateUnavailability = arr;
    p.availability = computeAvailability(participantId);
  }
  notify();
}

export function getDateUnavailabilities(participantId: string): DateUnavailability[] {
  return dateUnavailabilities.get(participantId) || [];
}

/**
 * Add the same DateUnavailability rule to multiple participants in one
 * undo-able action.  Returns the count of successfully added entries.
 */
export function addDateUnavailabilityBulk(
  participantIds: string[],
  rule: Omit<DateUnavailability, 'id'>,
): number {
  const validIds = participantIds.filter(id => participants.has(id));
  if (validIds.length === 0) return 0;
  pushSnapshot();
  _suppressSnapshot = true;
  let count = 0;
  try {
    for (const pid of validIds) {
      const du: DateUnavailability = { ...rule, id: uid('du') };
      const arr = dateUnavailabilities.get(pid) || [];
      arr.push(du);
      dateUnavailabilities.set(pid, arr);
      const p = participants.get(pid)!;
      p.dateUnavailability = arr;
      p.availability = computeAvailability(pid);
      count++;
    }
  } finally {
    _suppressSnapshot = false;
  }
  notify();
  return count;
}

// ─── Task Template Store ─────────────────────────────────────────────────────

const taskTemplates: Map<string, TaskTemplate> = new Map();

export function addTaskTemplate(tpl: Omit<TaskTemplate, 'id'>): TaskTemplate {
  pushSnapshot();
  const id = uid('tpl');
  const full: TaskTemplate = {
    ...tpl,
    id,
    baseLoadWeight: tpl.isLight ? 0 : (tpl.baseLoadWeight ?? 1),
    loadWindows: (tpl.loadWindows || []).map(w => ({ ...w })),
  };
  taskTemplates.set(id, full);
  notify();
  return full;
}

export function updateTaskTemplate(id: string, patch: Partial<Omit<TaskTemplate, 'id'>>): void {
  const tpl = taskTemplates.get(id);
  if (!tpl) return;
  pushSnapshot();
  Object.assign(tpl, patch);
  if (patch.loadWindows) {
    tpl.loadWindows = patch.loadWindows.map((w) => ({ ...w }));
  }
  if (patch.isLight !== undefined && patch.isLight) {
    tpl.baseLoadWeight = 0;
  }
  if (patch.baseLoadWeight !== undefined && !tpl.isLight) {
    tpl.baseLoadWeight = Math.max(0, Math.min(1, patch.baseLoadWeight));
  }
  notify();
}

export function removeTaskTemplate(id: string): void {
  if (!taskTemplates.has(id)) return;
  pushSnapshot();
  taskTemplates.delete(id);
  notify();
}

export function getTaskTemplate(id: string): TaskTemplate | undefined {
  return taskTemplates.get(id);
}

export function getAllTaskTemplates(): TaskTemplate[] {
  return [...taskTemplates.values()];
}

// ─── Slot / Sub-Team helpers ─────────────────────────────────────────────────

export function addSlotToTemplate(templateId: string, slot: Omit<SlotTemplate, 'id'>): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  pushSnapshot();
  tpl.slots.push({ ...slot, id: uid('slot') });
  notify();
}

export function removeSlotFromTemplate(templateId: string, slotId: string): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  pushSnapshot();
  tpl.slots = tpl.slots.filter(s => s.id !== slotId);
  notify();
}

export function addSubTeamToTemplate(templateId: string, name: string): SubTeamTemplate {
  const tpl = taskTemplates.get(templateId);
  const st: SubTeamTemplate = { id: uid('st'), name, slots: [] };
  if (tpl) {
    pushSnapshot();
    tpl.subTeams.push(st);
    notify();
  }
  return st;
}

export function removeSubTeamFromTemplate(templateId: string, subTeamId: string): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  pushSnapshot();
  tpl.subTeams = tpl.subTeams.filter(s => s.id !== subTeamId);
  notify();
}

export function addSlotToSubTeam(templateId: string, subTeamId: string, slot: Omit<SlotTemplate, 'id'>): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  const st = tpl.subTeams.find(s => s.id === subTeamId);
  if (!st) return;
  pushSnapshot();
  st.slots.push({ ...slot, id: uid('slot') });
  notify();
}

export function removeSlotFromSubTeam(templateId: string, subTeamId: string, slotId: string): void {
  const tpl = taskTemplates.get(templateId);
  if (!tpl) return;
  const st = tpl.subTeams.find(s => s.id === subTeamId);
  if (!st) return;
  pushSnapshot();
  st.slots = st.slots.filter(s => s.id !== slotId);
  notify();
}

// ─── Seed Default Data ───────────────────────────────────────────────────────

export function seedDefaultParticipants(): void {
  // 4 Departments × 12 participants = 48 total
  // Per department:
  //   1× L4 (Nitzan)
  //   1× L3 (Nitzan)
  //   3× L2 (Nitzan)
  //   1× L0 + Salsala (Nitzan)
  //   2× L0 + Hamama (Nitzan)
  //   4× L0 standard (Nitzan)
  // All have Nitzan. 2 Hamama-certified L0, 1 Salsala-certified L0.
  //
  // Horesh certification defaults:
  //   Dept A: 2 standard L0 participants (indices 8,9)
  //   Dept B: 1 standard L0 participant  (index 8)
  //   Dept C: 1 standard L0 participant  (index 8)
  //   Dept D: none

  const deptNames = ['קבוצה 1', 'קבוצה 2', 'קבוצה 3', 'קבוצה 4'];

  interface MemberSpec { level: Level; certs: Certification[]; tag: string }
  const template: MemberSpec[] = [
    { level: Level.L4, certs: [Certification.Nitzan], tag: 'L4' },
    { level: Level.L3, certs: [Certification.Nitzan], tag: 'L3' },
    { level: Level.L2, certs: [Certification.Nitzan], tag: 'L2' },
    { level: Level.L2, certs: [Certification.Nitzan], tag: 'L2' },
    { level: Level.L2, certs: [Certification.Nitzan], tag: 'L2' },
    { level: Level.L0, certs: [Certification.Nitzan, Certification.Salsala], tag: 'L0-Salsala' },
    { level: Level.L0, certs: [Certification.Nitzan, Certification.Hamama], tag: 'L0-Hamama' },
    { level: Level.L0, certs: [Certification.Nitzan, Certification.Hamama], tag: 'L0-Hamama' },
    { level: Level.L0, certs: [Certification.Nitzan], tag: 'L0' },
    { level: Level.L0, certs: [Certification.Nitzan], tag: 'L0' },
    { level: Level.L0, certs: [Certification.Nitzan], tag: 'L0' },
    { level: Level.L0, certs: [Certification.Nitzan], tag: 'L0' },
  ];

  // Horesh certification per department: set of template indices
  const horeshByDept: Record<string, Set<number>> = {
    'קבוצה 1': new Set([8, 9]),  // 2 standard L0 participants
    'קבוצה 2': new Set([8]),     // 1 standard L0 participant
    'קבוצה 3': new Set([8]),     // 1 standard L0 participant
  };

  for (const dept of deptNames) {
    const horeshIndices = horeshByDept[dept];
    template.forEach((spec, i) => {
      const id = uid('p');
      const certs = [...spec.certs];
      if (horeshIndices?.has(i)) certs.push(Certification.Horesh);
      const p: Participant = {
        id,
        name: `חלוץ ${i + 1} ${dept}`,
        level: spec.level,
        certifications: certs,
        group: dept,
        availability: getDefaultAvailability(),
        dateUnavailability: [],
      };
      participants.set(id, p);
    });
  }
  notify();
}

export function seedDefaultTaskTemplates(): void {
  // Adanit
  addTaskTemplate({
    name: 'אדנית',
    taskType: TaskType.Adanit,
    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: true,
    isLight: false,
    baseLoadWeight: 1,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [
      {
        id: uid('st'), name: 'סגול ראשי', slots: [
          { id: uid('slot'), label: 'סגול ראשי L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
          { id: uid('slot'), label: 'סגול ראשי L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
          { id: uid('slot'), label: 'סגול ראשי L3/L4', acceptableLevels: [Level.L3, Level.L4], requiredCertifications: [Certification.Nitzan] },
        ],
      },
      {
        id: uid('st'), name: 'סגול משני', slots: [
          { id: uid('slot'), label: 'סגול משני L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
          { id: uid('slot'), label: 'סגול משני L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
          { id: uid('slot'), label: 'סגול משני L2', acceptableLevels: [Level.L2], requiredCertifications: [Certification.Nitzan] },
        ],
      },
    ],
    slots: [],
    description: 'משמרות 8 שעות (מחזור 05:00), 3 ביום. שתי תת-קבוצות. כל 6 חייבים ניצן. אותה קבוצה.',
  });

  // Hamama
  addTaskTemplate({
    name: 'חממה',
    taskType: TaskType.Hamama,
    durationHours: 12,
    shiftsPerDay: 2,
    startHour: 6,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 5 / 6,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'חממה מפעיל', acceptableLevels: [Level.L0, Level.L2, Level.L3, Level.L4], requiredCertifications: [Certification.Hamama] },
    ],
    description: 'משמרות 12 שעות (06:00-18:00, 18:00-06:00). דורש הסמכת חממה. L2/L4 אסור. ללא דרישת ניצן.',
  });

  // Shemesh
  addTaskTemplate({
    name: 'שמש',
    taskType: TaskType.Shemesh,
    durationHours: 4,
    shiftsPerDay: 6,
    startHour: 5,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 1,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'שמש #1', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
      { id: uid('slot'), label: 'שמש #2', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
    ],
    description: 'משמרות 4 שעות (מחזור 05:00), 6 ביום. דורש ניצן. עדיפות לאותה קבוצה (רך).',
  });

  // Mamtera
  addTaskTemplate({
    name: 'ממטרה',
    taskType: TaskType.Mamtera,
    durationHours: 14,
    shiftsPerDay: 1,
    startHour: 9,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 4 / 9,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'ממטרה L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'ממטרה L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [] },
    ],
    description: '09:00-23:00. 2× L0.',
  });

  // Karov
  addTaskTemplate({
    name: 'כרוב',
    taskType: TaskType.Karov,
    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 1 / 3,
    blocksConsecutive: false,
    loadWindows: [
      {
        id: uid('lw'),
        startHour: 5,
        startMinute: 0,
        endHour: 6,
        endMinute: 30,
        weight: 1,
      },
      {
        id: uid('lw'),
        startHour: 17,
        startMinute: 0,
        endHour: 18,
        endMinute: 30,
        weight: 1,
      },
    ],
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'כרוב מפקד (L2+)', acceptableLevels: [Level.L2, Level.L3, Level.L4], requiredCertifications: [] },
      { id: uid('slot'), label: 'כרוב L0 + סלסלה', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Salsala] },
      { id: uid('slot'), label: 'כרוב L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'כרוב L0 #3', acceptableLevels: [Level.L0], requiredCertifications: [] },
    ],
    description: 'משמרות 8 שעות (מחזור 05:00), 3 ביום. 1× L2+, 1× L0 עם סלסלה, 2× L0. חלונות חמים 05:00-06:30 ו-17:00-18:30 ב-100%; מחוץ לחלון ~33% עומס.',
  });

  // Karovit
  addTaskTemplate({
    name: 'כרובית',
    taskType: TaskType.Karovit,
    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: false,
    isLight: true,
    baseLoadWeight: 0,
    loadWindows: [],
    blocksConsecutive: false,
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'כרובית מפקד (L2+)', acceptableLevels: [Level.L2, Level.L3, Level.L4], requiredCertifications: [] },
      { id: uid('slot'), label: 'כרובית L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'כרובית L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'כרובית L0 #3', acceptableLevels: [Level.L0], requiredCertifications: [] },
    ],
    description: 'משמרות 8 שעות (מחזור 05:00), 3 ביום. 1× L2+, 3× L0. קל — ללא השפעה על מנוחה.',
  });

  // Aruga
  addTaskTemplate({
    name: 'ערוגה',
    taskType: TaskType.Aruga,
    durationHours: 1.5,
    shiftsPerDay: 2,
    startHour: 5,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 1,
    loadWindows: [],
    blocksConsecutive: true,
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'ערוגה L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'ערוגה L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [] },
    ],
    description: '1.5 שעות, 2 ביום (בוקר 05:00-06:30, ערב 17:00-18:30). 2× L0.',
  });
}

// ─── Initialization ──────────────────────────────────────────────────────────

let _initRunning = false;

export function initStore(): void {
  if (_initRunning) {
    console.warn('[Store] initStore() re-entrance blocked');
    return;
  }
  _initRunning = true;
  try {
    participants.clear();
    blackouts.clear();
    dateUnavailabilities.clear();
    taskTemplates.clear();
    undoStack.length = 0;
    redoStack.length = 0;
    // Try to load from storage first
    if (loadFromStorage()) {
      console.log('[Store] Restored state from localStorage');
      return;
    }
    // Suppress snapshots during seed (initial state shouldn't be undoable)
    _suppressSnapshot = true;
    seedDefaultParticipants();
    seedDefaultTaskTemplates();
  } finally {
    _suppressSnapshot = false;
    _initRunning = false;
  }
}

// ─── Live Mode State ─────────────────────────────────────────────────────────

let liveModeState: LiveModeState = {
  enabled: false,
  currentTimestamp: new Date(),
};

export function getLiveModeState(): LiveModeState {
  return { ...liveModeState, currentTimestamp: new Date(liveModeState.currentTimestamp.getTime()) };
}

export function setLiveModeEnabled(enabled: boolean): void {
  liveModeState.enabled = enabled;
  // Always refresh timestamp to "now" so the day picker reflects the current day
  liveModeState.currentTimestamp = new Date();
  // Only persist — don't fire general notify() which would falsely mark the schedule
  // as dirty. The live-mode checkbox handler in app.ts already calls renderAll().
  debouncedSave();
}

export function setLiveModeTimestamp(timestamp: Date): void {
  liveModeState.currentTimestamp = timestamp;
  // Only persist — don't fire general notify() which would falsely mark the schedule
  // as dirty. The caller already triggers renderAll() when needed.
  debouncedSave();
}

// ─── localStorage Persistence ────────────────────────────────────────────────

const STORAGE_KEY_STATE = 'gardenmanager_state';
const STORAGE_KEY_SCHEDULE = 'gardenmanager_schedule';

let _saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 500;

/**
 * Deep-serialize dates to ISO strings in a JSON-compatible way.
 * Uses a replacer function so Date objects in nested structures are handled.
 *
 * NOTE: This serializer (with its `{ __date__: ... }` markers and matching
 * `jsonDeserialize` reviver) is used only for the Schedule blob, whose
 * shape has Dates at arbitrary nesting depths.  The state blob
 * (`saveToStorage`) uses manual `.toISOString()` + plain `JSON.parse`
 * because its structure is flat and well-known.  The two persistence
 * paths are intentionally separate — do not unify without updating both
 * the save and load sides.
 */
function jsonSerialize(obj: unknown): string {
  // Must use a regular function (not arrow) so `this` is the holder object.
  // JSON.stringify calls Date.toJSON() *before* the replacer sees the value,
  // so `value` is already a string for Dates.  `this[key]` gives the raw Date.
  return JSON.stringify(obj, function (key, value) {
    const raw = this[key];
    if (raw instanceof Date) {
      return { __date__: raw.toISOString() };
    }
    return value;
  });
}

/**
 * Deep-deserialize ISO date strings back to Date objects.
 * Uses a reviver function that matches the serialization format.
 */
function jsonDeserialize<T>(json: string): T {
  return JSON.parse(json, (_key, value) => {
    if (value && typeof value === 'object' && '__date__' in value) {
      return new Date(value.__date__);
    }
    // Backward compat: data saved by the old (broken) serializer stored
    // Dates as bare ISO-8601 strings without the { __date__ } wrapper.
    if (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
    ) {
      return new Date(value);
    }
    return value;
  }) as T;
}

/**
 * Save the full store state to localStorage.
 * Called automatically (debounced) after every store mutation.
 */
export function saveToStorage(): void {
  try {
    const state = {
      version: 2,
      scheduleDate: scheduleDate.toISOString(),
      scheduleDays,
      liveMode: {
        enabled: liveModeState.enabled,
        currentTimestamp: liveModeState.currentTimestamp.toISOString(),
      },
      // Bug #8 fix: omit inline dateUnavailability from participant
      // serialization — the dateUnavailabilities Map is the single
      // source of truth (serialized separately below).
      participants: Array.from(participants.values()).map(p => {
        const { dateUnavailability: _, ...rest } = p;
        return {
          ...rest,
          availability: p.availability.map(w => ({
            start: w.start.toISOString(),
            end: w.end.toISOString(),
          })),
        };
      }),
      blackouts: Array.from(blackouts.entries()).map(([pid, bouts]) => ({
        pid,
        bouts: bouts.map(b => ({
          ...b,
          start: b.start.toISOString(),
          end: b.end.toISOString(),
        })),
      })),
      dateUnavailabilities: Array.from(dateUnavailabilities.entries()).map(([pid, rules]) => ({
        pid,
        rules,
      })),
      taskTemplates: Array.from(taskTemplates.values()),
    };
    localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(state));
  } catch (err) {
    console.warn('[Store] Failed to save to localStorage:', err);
  }
}

/**
 * Load the full store state from localStorage.
 * Returns true if state was successfully restored.
 */
export function loadFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_STATE);
    if (!raw) return false;

    const state = JSON.parse(raw);
    if (!state || (state.version !== 1 && state.version !== 2)) return false;

    // ── Migration v1 → v2: update baseLoadWeight for Hamama/Mamtera/Karov ──
    if (state.version === 1 && Array.isArray(state.taskTemplates)) {
      for (const tpl of state.taskTemplates) {
        if (tpl.taskType === 'Hamama' && (tpl.baseLoadWeight === 0.6 || tpl.baseLoadWeight === undefined)) {
          tpl.baseLoadWeight = 5 / 6;
        }
        if (tpl.taskType === 'Mamtera' && (tpl.baseLoadWeight === 1 || tpl.baseLoadWeight === undefined)) {
          tpl.baseLoadWeight = 4 / 9;
        }
        if (tpl.taskType === 'Karov' && (tpl.baseLoadWeight === 0.2 || tpl.baseLoadWeight === undefined)) {
          tpl.baseLoadWeight = 1 / 3;
          if (typeof tpl.description === 'string') {
            tpl.description = tpl.description.replace('חיצוני הוא 20% עומס', 'חיצוני הוא ~33% עומס');
          }
        }
      }
      state.version = 2;
    }

    // Restore schedule date/days
    scheduleDate = new Date(state.scheduleDate);
    scheduleDays = state.scheduleDays || 7;

    // Restore live mode state
    if (state.liveMode) {
      liveModeState = {
        enabled: state.liveMode.enabled || false,
        currentTimestamp: new Date(state.liveMode.currentTimestamp),
      };
    }

    // Restore participants
    participants.clear();
    blackouts.clear();
    dateUnavailabilities.clear();

    for (const pData of (state.participants || [])) {
      const p: Participant = {
        ...pData,
        availability: (pData.availability || []).map((w: { start: string; end: string }) => ({
          start: new Date(w.start),
          end: new Date(w.end),
        })),
        dateUnavailability: pData.dateUnavailability || [],
      };
      participants.set(p.id, p);
    }

    // Restore blackouts
    for (const entry of (state.blackouts || [])) {
      const bouts: BlackoutPeriod[] = (entry.bouts || []).map((b: { id: string; start: string; end: string; reason?: string }) => ({
        ...b,
        start: new Date(b.start),
        end: new Date(b.end),
      }));
      if (bouts.length > 0) {
        blackouts.set(entry.pid, bouts);
      }
    }

    // Restore date unavailabilities
    for (const entry of (state.dateUnavailabilities || [])) {
      if (entry.rules && entry.rules.length > 0) {
        dateUnavailabilities.set(entry.pid, entry.rules);
      }
    }

    // Bug #1 fix: sync participant inline dateUnavailability to the canonical Map
    for (const [id, p] of participants) {
      p.dateUnavailability = dateUnavailabilities.get(id) || [];
    }

    // Restore task templates
    taskTemplates.clear();
    for (const tpl of (state.taskTemplates || [])) {
      taskTemplates.set(tpl.id, tpl);
    }

    // Bug #5 fix: recompute availability from canonical inputs instead of
    // using the stale windows that were serialised at save time.
    recalcAllAvailability();

    // Re-persist after migration so updated version/values are saved
    if (state.version === 2) {
      try { saveToStorage(); } catch (_) { /* best-effort */ }
    }

    return true;
  } catch (err) {
    console.warn('[Store] Failed to load from localStorage:', err);
    return false;
  }
}

/**
 * Save a full Schedule object to localStorage.
 * Called after generation, swaps, locks, and rescue-apply operations.
 */
export function saveSchedule(schedule: Schedule): void {
  try {
    localStorage.setItem(STORAGE_KEY_SCHEDULE, jsonSerialize(schedule));
  } catch (err) {
    console.warn('[Store] Failed to save schedule to localStorage:', err);
  }
}

/**
 * Load a saved Schedule from localStorage.
 * Returns null if no schedule is saved or deserialization fails.
 */
export function loadSchedule(): Schedule | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SCHEDULE);
    if (!raw) return null;
    return jsonDeserialize<Schedule>(raw);
  } catch (err) {
    console.warn('[Store] Failed to load schedule from localStorage:', err);
    return null;
  }
}

/**
 * Clear all persisted state (reset to defaults on next load).
 */
export function clearStorage(): void {
  // Cancel any pending debounced save to prevent re-persisting stale data
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
  }
  try {
    localStorage.removeItem(STORAGE_KEY_STATE);
    localStorage.removeItem(STORAGE_KEY_SCHEDULE);
  } catch (err) {
    console.warn('[Store] Failed to clear localStorage:', err);
  }
  // Also clear in-memory state so the app is consistent
  participants.clear();
  blackouts.clear();
  dateUnavailabilities.clear();
  taskTemplates.clear();
  undoStack.length = 0;
  redoStack.length = 0;
}

/**
 * Schedule a debounced save to localStorage.
 * Called from notify() so every store mutation triggers persistence.
 */
function debouncedSave(): void {
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(() => {
    saveToStorage();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Flush any pending debounced save immediately.
 * Used by beforeunload to avoid losing the last mutation.
 */
export function flushPendingSave(): void {
  if (_saveDebounceTimer) {
    clearTimeout(_saveDebounceTimer);
    _saveDebounceTimer = null;
    saveToStorage();
  }
}

// ─── Algorithm Settings (separate from undo/redo) ────────────────────────────

const STORAGE_KEY_ALGORITHM = 'gardenmanager_algorithm';

let _algorithmSettings: AlgorithmSettings | null = null;

/**
 * Get current algorithm settings (lazy-loaded from localStorage).
 * Returns a deep copy so mutations don't leak.
 */
export function getAlgorithmSettings(): AlgorithmSettings {
  if (!_algorithmSettings) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ALGORITHM);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AlgorithmSettings>;
        // Merge with defaults to handle any newly-added fields
        _algorithmSettings = {
          config: { ...DEFAULT_ALGORITHM_SETTINGS.config, ...(parsed.config || {}) },
          disabledHardConstraints: Array.isArray(parsed.disabledHardConstraints)
            ? parsed.disabledHardConstraints as HardConstraintCode[]
            : [],
          disabledSoftWarnings: Array.isArray(parsed.disabledSoftWarnings)
            ? parsed.disabledSoftWarnings as SoftWarningCode[]
            : [],
        };
      } else {
        _algorithmSettings = {
          config: { ...DEFAULT_ALGORITHM_SETTINGS.config },
          disabledHardConstraints: [...DEFAULT_ALGORITHM_SETTINGS.disabledHardConstraints],
          disabledSoftWarnings: [...DEFAULT_ALGORITHM_SETTINGS.disabledSoftWarnings],
        };
      }
    } catch {
      _algorithmSettings = {
        config: { ...DEFAULT_ALGORITHM_SETTINGS.config },
        disabledHardConstraints: [...DEFAULT_ALGORITHM_SETTINGS.disabledHardConstraints],
        disabledSoftWarnings: [...DEFAULT_ALGORITHM_SETTINGS.disabledSoftWarnings],
      };
    }
  }
  return {
    config: { ..._algorithmSettings.config },
    disabledHardConstraints: [..._algorithmSettings.disabledHardConstraints],
    disabledSoftWarnings: [..._algorithmSettings.disabledSoftWarnings],
  };
}

/**
 * Update algorithm settings (partial merge). Persists immediately.
 * Does NOT fire notify() — changes take effect on next generate/revalidate.
 */
export function setAlgorithmSettings(patch: Partial<AlgorithmSettings>): void {
  const current = getAlgorithmSettings();
  _algorithmSettings = {
    config: patch.config ? { ...current.config, ...patch.config } : current.config,
    disabledHardConstraints: patch.disabledHardConstraints !== undefined
      ? [...patch.disabledHardConstraints]
      : current.disabledHardConstraints,
    disabledSoftWarnings: patch.disabledSoftWarnings !== undefined
      ? [...patch.disabledSoftWarnings]
      : current.disabledSoftWarnings,
  };
  _saveAlgorithmSettings();
}

/**
 * Reset algorithm settings to factory defaults. Persists immediately.
 * Also sets the active preset to the built-in Default.
 */
export function resetAlgorithmSettings(): void {
  _algorithmSettings = {
    config: { ...DEFAULT_ALGORITHM_SETTINGS.config },
    disabledHardConstraints: [...DEFAULT_ALGORITHM_SETTINGS.disabledHardConstraints],
    disabledSoftWarnings: [...DEFAULT_ALGORITHM_SETTINGS.disabledSoftWarnings],
  };
  _saveAlgorithmSettings();
  // Also switch active preset to Default
  _initPresets(); // ensure loaded
  _activePresetId = DEFAULT_PRESET.id;
  _saveActivePresetId();
}

/**
 * Build a Set of disabled hard constraint codes for efficient lookup.
 */
export function getDisabledHCSet(): Set<string> {
  const settings = getAlgorithmSettings();
  return new Set(settings.disabledHardConstraints);
}

/**
 * Build a Set of disabled soft warning codes for efficient lookup.
 */
export function getDisabledSWSet(): Set<string> {
  const settings = getAlgorithmSettings();
  return new Set(settings.disabledSoftWarnings);
}

function _saveAlgorithmSettings(): void {
  if (!_algorithmSettings) return;
  try {
    localStorage.setItem(STORAGE_KEY_ALGORITHM, JSON.stringify(_algorithmSettings));
  } catch (err) {
    console.warn('[Store] Failed to save algorithm settings:', err);
  }
}

// ─── Algorithm Presets ───────────────────────────────────────────────────────

const STORAGE_KEY_PRESETS = 'gardenmanager_algorithm_presets';
const STORAGE_KEY_ACTIVE_PRESET = 'gardenmanager_active_preset_id';

let _presets: AlgorithmPreset[] | null = null;
let _activePresetId: string | null | undefined = undefined; // undefined = not yet loaded

/**
 * Hook for tab-algorithm to register its debounce-flush function.
 * Called before any save/update operation to ensure pending slider
 * changes are applied to the working copy first.
 */
let _flushPendingWeightUpdate: (() => void) | null = null;

export function registerWeightFlush(fn: () => void): void {
  _flushPendingWeightUpdate = fn;
}

function _flushWeights(): void {
  if (_flushPendingWeightUpdate) _flushPendingWeightUpdate();
}

/** Lazily initialise presets from localStorage, with first-load migration. */
function _initPresets(): AlgorithmPreset[] {
  if (_presets) return _presets;

  const raw = localStorage.getItem(STORAGE_KEY_PRESETS);
  if (raw) {
    try {
      _presets = JSON.parse(raw) as AlgorithmPreset[];
      // Ensure the built-in Default preset always exists
      if (!_presets.find(p => p.id === DEFAULT_PRESET.id)) {
        _presets.unshift(_deepCopyPreset(DEFAULT_PRESET));
      }
    } catch {
      _presets = [_deepCopyPreset(DEFAULT_PRESET)];
    }
  } else {
    // First load — migrate existing working copy
    _presets = [_deepCopyPreset(DEFAULT_PRESET)];
    const current = getAlgorithmSettings();
    const defaultJson = JSON.stringify(DEFAULT_ALGORITHM_SETTINGS);
    const currentJson = JSON.stringify(current);
    if (currentJson !== defaultJson) {
      // User had customised settings before presets existed — preserve them
      const migrated: AlgorithmPreset = {
        id: uid('preset'),
        name: 'ההגדרות שלי',
        description: 'הועבר מהגדרות האלגוריתם הקודמות שלך',
        settings: current,
        createdAt: Date.now(),
      };
      _presets.push(migrated);
      _activePresetId = migrated.id;
    } else {
      _activePresetId = DEFAULT_PRESET.id;
    }
    _savePresets();
    _saveActivePresetId();
  }

  // Load active preset id if not already set by migration
  if (_activePresetId === undefined) {
    _activePresetId = localStorage.getItem(STORAGE_KEY_ACTIVE_PRESET) || DEFAULT_PRESET.id;
  }

  return _presets;
}

function _deepCopyPreset(p: AlgorithmPreset): AlgorithmPreset {
  return {
    ...p,
    settings: {
      config: { ...p.settings.config },
      disabledHardConstraints: [...p.settings.disabledHardConstraints],
      disabledSoftWarnings: [...p.settings.disabledSoftWarnings],
    },
  };
}

function _savePresets(): void {
  if (!_presets) return;
  try {
    localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(_presets));
  } catch (err) {
    console.warn('[Store] Failed to save algorithm presets:', err);
  }
}

function _saveActivePresetId(): void {
  try {
    if (_activePresetId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_PRESET, _activePresetId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_PRESET);
    }
  } catch (err) {
    console.warn('[Store] Failed to save active preset id:', err);
  }
}

/** Case-insensitive trimmed name duplicate check */
function _isPresetNameTaken(name: string, excludeId?: string): boolean {
  const norm = name.trim().toLowerCase();
  const presets = _initPresets();
  return presets.some(p => p.name.trim().toLowerCase() === norm && p.id !== excludeId);
}

// ─── Preset Public API ──────────────────────────────────────────────────────

/** Get all presets (built-in first, then by createdAt) */
export function getAllPresets(): AlgorithmPreset[] {
  const presets = _initPresets();
  return presets
    .slice()
    .sort((a, b) => {
      if (a.builtIn && !b.builtIn) return -1;
      if (!a.builtIn && b.builtIn) return 1;
      return a.createdAt - b.createdAt;
    })
    .map(p => _deepCopyPreset(p));
}

/** Get a single preset by id */
export function getPresetById(id: string): AlgorithmPreset | undefined {
  const presets = _initPresets();
  const found = presets.find(p => p.id === id);
  return found ? _deepCopyPreset(found) : undefined;
}

/** Get the active preset id (may be null if none) */
export function getActivePresetId(): string | null {
  _initPresets(); // ensure loaded
  return _activePresetId ?? null;
}

/**
 * Load a preset into the working copy.
 * Replaces algorithm settings entirely (not a partial merge).
 */
export function loadPreset(id: string): void {
  const preset = getPresetById(id);
  if (!preset) return;
  // Full replacement — not partial merge
  _algorithmSettings = {
    config: { ...preset.settings.config },
    disabledHardConstraints: [...preset.settings.disabledHardConstraints],
    disabledSoftWarnings: [...preset.settings.disabledSoftWarnings],
  };
  _saveAlgorithmSettings();
  _activePresetId = id;
  _saveActivePresetId();
}

/**
 * Save the current working copy as a new preset.
 * Returns the new preset, or null if the name is taken.
 */
export function saveCurrentAsPreset(name: string, description: string): AlgorithmPreset | null {
  _flushWeights();
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (_isPresetNameTaken(trimmed)) return null;

  const preset: AlgorithmPreset = {
    id: uid('preset'),
    name: trimmed,
    description: description.trim(),
    settings: getAlgorithmSettings(), // deep copy via getter
    createdAt: Date.now(),
  };

  const presets = _initPresets();
  presets.push(preset);
  _savePresets();

  _activePresetId = preset.id;
  _saveActivePresetId();

  return _deepCopyPreset(preset);
}

/**
 * Overwrite an existing preset's settings with the current working copy.
 * Returns false if preset not found or is built-in.
 */
export function updatePreset(id: string): boolean {
  _flushWeights();
  const presets = _initPresets();
  const idx = presets.findIndex(p => p.id === id);
  if (idx === -1) return false;
  if (presets[idx].builtIn) return false;

  presets[idx].settings = getAlgorithmSettings(); // deep copy via getter
  _savePresets();
  return true;
}

/**
 * Rename a preset. Returns null on success, or an error string.
 */
export function renamePreset(id: string, name: string, description: string): string | null {
  const presets = _initPresets();
  const preset = presets.find(p => p.id === id);
  if (!preset) return 'פריסט לא נמצא';
  if (preset.builtIn) return 'לא ניתן לשנות שם של פריסט מובנה';

  const trimmed = name.trim();
  if (!trimmed) return 'השם לא יכול להיות ריק';
  if (_isPresetNameTaken(trimmed, id)) return 'פריסט עם שם זה כבר קיים';

  preset.name = trimmed;
  preset.description = description.trim();
  _savePresets();
  return null;
}

/**
 * Duplicate a preset with a unique name.
 * Returns the new preset.
 */
export function duplicatePreset(id: string): AlgorithmPreset | null {
  const source = getPresetById(id);
  if (!source) return null;

  const presets = _initPresets();
  let newName = source.name + ' (עותק)';
  let attempt = 2;
  while (_isPresetNameTaken(newName)) {
    newName = `${source.name} (עותק ${attempt++})`;
  }

  const dup: AlgorithmPreset = {
    id: uid('preset'),
    name: newName,
    description: source.description,
    settings: source.settings, // already a deep copy from getPresetById
    builtIn: false,
    createdAt: Date.now(),
  };
  presets.push(dup);
  _savePresets();
  return _deepCopyPreset(dup);
}

/**
 * Delete a preset. If it was the active one, load the Default preset.
 * Returns false if preset not found or is built-in.
 */
export function deletePreset(id: string): boolean {
  const presets = _initPresets();
  const idx = presets.findIndex(p => p.id === id);
  if (idx === -1) return false;
  if (presets[idx].builtIn) return false;

  presets.splice(idx, 1);
  _savePresets();

  if (_activePresetId === id) {
    loadPreset(DEFAULT_PRESET.id);
  }
  return true;
}

/**
 * Compare the current working copy against the active preset.
 * Returns true if they differ (preset is "dirty").
 * Survives page reloads because both sides come from localStorage.
 */
export function isPresetDirty(): boolean {
  const activeId = getActivePresetId();
  if (!activeId) return false;
  const preset = getPresetById(activeId);
  if (!preset) return false;
  return JSON.stringify(getAlgorithmSettings()) !== JSON.stringify(preset.settings);
}
