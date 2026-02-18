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
  scheduleDate = d;
  recalcAllAvailability();
  notify();
}
export function setScheduleDays(n: number): void {
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
          if (endH <= rule.startHour) { endDay += 1; } // crosses midnight
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

  const deptNames = ['Dept A', 'Dept B', 'Dept C', 'Dept D'];

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
    'Dept A': new Set([8, 9]),  // 2 standard L0 participants
    'Dept B': new Set([8]),     // 1 standard L0 participant
    'Dept C': new Set([8]),     // 1 standard L0 participant
  };

  for (const dept of deptNames) {
    const horeshIndices = horeshByDept[dept];
    template.forEach((spec, i) => {
      const id = uid('p');
      const num = String(i + 1).padStart(2, '0');
      const certs = [...spec.certs];
      if (horeshIndices?.has(i)) certs.push(Certification.Horesh);
      const p: Participant = {
        id,
        name: `${dept} - Participant ${num}`,
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
    name: 'Adanit',
    taskType: TaskType.Adanit,
    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: true,
    isLight: false,
    baseLoadWeight: 1,
    loadWindows: [],
    subTeams: [
      {
        id: uid('st'), name: 'Segol Main', slots: [
          { id: uid('slot'), label: 'Segol Main L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
          { id: uid('slot'), label: 'Segol Main L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
          { id: uid('slot'), label: 'Segol Main L3/L4', acceptableLevels: [Level.L3, Level.L4], requiredCertifications: [Certification.Nitzan] },
        ],
      },
      {
        id: uid('st'), name: 'Segol Secondary', slots: [
          { id: uid('slot'), label: 'Segol Secondary L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
          { id: uid('slot'), label: 'Segol Secondary L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Nitzan] },
          { id: uid('slot'), label: 'Segol Secondary L2+', acceptableLevels: [Level.L2, Level.L3, Level.L4], requiredCertifications: [Certification.Nitzan] },
        ],
      },
    ],
    slots: [],
    description: '8h shifts (05:00 cycle), 3/day. Two sub-teams. All 6 must have Nitzan. Same group.',
  });

  // Hamama
  addTaskTemplate({
    name: 'Hamama',
    taskType: TaskType.Hamama,
    durationHours: 12,
    shiftsPerDay: 2,
    startHour: 6,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 1,
    loadWindows: [],
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'Hamama Operator', acceptableLevels: [Level.L0, Level.L3], requiredCertifications: [Certification.Hamama] },
    ],
    description: '12h shifts (06:00-18:00, 18:00-06:00). Requires Hamama cert. L2/L4 forbidden. No Nitzan req.',
  });

  // Shemesh
  addTaskTemplate({
    name: 'Shemesh',
    taskType: TaskType.Shemesh,
    durationHours: 4,
    shiftsPerDay: 6,
    startHour: 5,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 1,
    loadWindows: [],
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'Shemesh #1', acceptableLevels: [Level.L0, Level.L2, Level.L3], requiredCertifications: [Certification.Nitzan] },
      { id: uid('slot'), label: 'Shemesh #2', acceptableLevels: [Level.L0, Level.L2, Level.L3], requiredCertifications: [Certification.Nitzan] },
    ],
    description: '4h shifts (05:00 cycle), 6/day. Requires Nitzan. Prefer same group (soft).',
  });

  // Mamtera
  addTaskTemplate({
    name: 'Mamtera',
    taskType: TaskType.Mamtera,
    durationHours: 14,
    shiftsPerDay: 1,
    startHour: 9,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 1,
    loadWindows: [],
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'Mamtera L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'Mamtera L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [] },
    ],
    description: '09:00-23:00. 2× L0.',
  });

  // Karov
  addTaskTemplate({
    name: 'Karov',
    taskType: TaskType.Karov,
    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 0.2,
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
      { id: uid('slot'), label: 'Karov Commander (L2+)', acceptableLevels: [Level.L2, Level.L3, Level.L4], requiredCertifications: [] },
      { id: uid('slot'), label: 'Karov L0 + Salsala', acceptableLevels: [Level.L0], requiredCertifications: [Certification.Salsala] },
      { id: uid('slot'), label: 'Karov L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'Karov L0 #3', acceptableLevels: [Level.L0], requiredCertifications: [] },
    ],
    description: '8h shifts (05:00 cycle), 3/day. 1× L2+, 1× L0 w/ Salsala, 2× L0. Hot windows 05:00-06:30 and 17:00-18:30 at 100%; outside is 20% load.',
  });

  // Karovit
  addTaskTemplate({
    name: 'Karovit',
    taskType: TaskType.Karovit,
    durationHours: 8,
    shiftsPerDay: 3,
    startHour: 5,
    sameGroupRequired: false,
    isLight: true,
    baseLoadWeight: 0,
    loadWindows: [],
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'Karovit Commander (L2+)', acceptableLevels: [Level.L2, Level.L3, Level.L4], requiredCertifications: [] },
      { id: uid('slot'), label: 'Karovit L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'Karovit L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'Karovit L0 #3', acceptableLevels: [Level.L0], requiredCertifications: [] },
    ],
    description: '8h shifts (05:00 cycle), 3/day. 1× L2+, 3× L0. Light — no rest impact.',
  });

  // Aruga
  addTaskTemplate({
    name: 'Aruga',
    taskType: TaskType.Aruga,
    durationHours: 1.5,
    shiftsPerDay: 2,
    startHour: 5,
    sameGroupRequired: false,
    isLight: false,
    baseLoadWeight: 1,
    loadWindows: [],
    subTeams: [],
    slots: [
      { id: uid('slot'), label: 'Aruga L0 #1', acceptableLevels: [Level.L0], requiredCertifications: [] },
      { id: uid('slot'), label: 'Aruga L0 #2', acceptableLevels: [Level.L0], requiredCertifications: [] },
    ],
    description: '1.5h, 2/day (morning 05:00-06:30, evening 17:00-18:30). 2× L0.',
  });
}

// ─── Initialization ──────────────────────────────────────────────────────────

export function initStore(): void {
  participants.clear();
  blackouts.clear();
  dateUnavailabilities.clear();
  taskTemplates.clear();
  undoStack.length = 0;
  redoStack.length = 0;
  // Suppress snapshots during seed (initial state shouldn't be undoable)
  _suppressSnapshot = true;
  seedDefaultParticipants();
  seedDefaultTaskTemplates();
  _suppressSnapshot = false;
}
