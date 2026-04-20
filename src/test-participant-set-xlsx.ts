/**
 * Tests for participant-set-xlsx — round-trip + negative + security.
 *
 * Invoked from `src/test.ts` via `runParticipantSetXlsxTests(assert)`. Cannot
 * run standalone because it shares the top-level `passed`/`failed` counters.
 *
 * The tests construct workbooks in-memory with exceljs (no file I/O), parse
 * them back, and assert on the result shape. This exercises the full
 * round-trip pipeline without touching the DOM.
 */

import ExcelJS from 'exceljs';
import {
  type CertificationDefinition,
  DEFAULT_CERTIFICATION_DEFINITIONS,
  Level,
  type PakalDefinition,
  type ParticipantSet,
  type ParticipantSnapshot,
} from './models/types';
import {
  FORMAT_MARKER,
  generateParticipantSetXlsx,
  MAX_PARTICIPANT_ROWS,
  parseParticipantSetXlsx,
  SCHEMA_VERSION,
  SHEET_CERTS,
  SHEET_META,
  SHEET_PAKALS,
  SHEET_PARTICIPANTS,
  SHEET_UNAVAILABILITY,
} from './shared/participant-set-xlsx';

type AssertFn = (condition: boolean, name: string) => void;

// ─── Helpers ────────────────────────────────────────────────────────────────

const DEFAULT_PAKALS: PakalDefinition[] = [
  { id: 'pakal-sq', label: 'מפקד כיתה' },
  { id: 'pakal-med', label: 'חובש' },
];

// Salsala is no longer part of DEFAULT_CERTIFICATION_DEFINITIONS (removed in
// v2.4.0), but the fixture participants below still reference it. Re-add it
// here so the round-trip preserves those cert assignments.
const SAMPLE_CERT_CATALOG: CertificationDefinition[] = [
  ...DEFAULT_CERTIFICATION_DEFINITIONS,
  { id: 'Salsala', label: 'סלסלה', color: '#8e44ad' },
];

function buildSamplePset(overrides: Partial<ParticipantSet> = {}): ParticipantSet {
  const participants: ParticipantSnapshot[] = [
    {
      name: 'אורן',
      level: Level.L3,
      certifications: ['Nitzan', 'Salsala'],
      group: 'קבוצה א',
      dateUnavailability: [
        { dayOfWeek: 5, allDay: true, startHour: 0, endHour: 0, reason: 'שבת' },
        { dayOfWeek: 2, allDay: false, startHour: 8, endHour: 12, reason: 'קורס' },
      ],
      pakalIds: ['pakal-sq'],
      notWithIds: ['דנה'],
    },
    {
      name: 'דנה',
      level: Level.L2,
      certifications: ['Hamama'],
      group: 'קבוצה ב',
      dateUnavailability: [{ dayOfWeek: 1, allDay: false, startHour: 22, endHour: 6, reason: 'משמרת לילה' }],
      pakalIds: [],
      notWithIds: ['אורן'],
    },
    {
      name: 'יובל',
      level: Level.L0,
      certifications: [],
      group: 'קבוצה א',
      dateUnavailability: [],
      preferredTaskName: 'חממה',
    },
    {
      name: 'רונית',
      level: Level.L4,
      certifications: ['Nitzan', 'Horesh'],
      group: 'קבוצה ב',
      dateUnavailability: [],
      pakalIds: ['pakal-med'],
      lessPreferredTaskName: 'ניצן',
    },
    {
      name: 'גיל',
      level: Level.L2,
      certifications: ['Salsala', 'Hamama', 'Horesh'],
      group: 'קבוצה ג',
      dateUnavailability: [{ dayOfWeek: 0, allDay: false, startHour: 13, endHour: 17 }],
    },
  ];

  return {
    id: 'pset-test',
    name: 'סט בדיקה',
    description: 'תיאור דוגמה',
    participants,
    certificationCatalog: SAMPLE_CERT_CATALOG,
    pakalCatalog: DEFAULT_PAKALS,
    createdAt: Date.now(),
    ...overrides,
  };
}

async function roundTrip(pset: ParticipantSet): Promise<Awaited<ReturnType<typeof parseParticipantSetXlsx>>> {
  const blob = await generateParticipantSetXlsx(pset);
  const buf = await blobToArrayBuffer(blob);
  return parseParticipantSetXlsx(buf);
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  // Node 18+: Blob has arrayBuffer() but typing may vary.
  if (typeof (blob as unknown as { arrayBuffer?: () => Promise<ArrayBuffer> }).arrayBuffer === 'function') {
    return (blob as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
  }
  throw new Error('Blob.arrayBuffer not available');
}

/** Normalize participant ordering and field order for deep-equal.
 *
 * Field order matters because the comparison uses JSON.stringify, which
 * serializes keys in insertion order. The parser output and the source
 * objects may have different field orders, so we rebuild with a fixed
 * canonical layout. */
function normalizeSnapshots(snaps: ParticipantSnapshot[]): Array<Record<string, unknown>> {
  return [...snaps]
    .map((p) => {
      const certs = [...p.certifications].sort();
      const pakals = p.pakalIds && p.pakalIds.length > 0 ? [...p.pakalIds].sort() : undefined;
      const notWith = p.notWithIds && p.notWithIds.length > 0 ? [...p.notWithIds].sort() : undefined;
      const rules = [...p.dateUnavailability].sort((a, b) => {
        if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
        return (a.startHour ?? 0) - (b.startHour ?? 0);
      });
      const canonical: Record<string, unknown> = {
        name: p.name,
        level: p.level,
        group: p.group,
        certifications: certs,
        dateUnavailability: rules,
      };
      if (pakals !== undefined) canonical.pakalIds = pakals;
      if (notWith !== undefined) canonical.notWithIds = notWith;
      if (p.preferredTaskName !== undefined) canonical.preferredTaskName = p.preferredTaskName;
      if (p.lessPreferredTaskName !== undefined) canonical.lessPreferredTaskName = p.lessPreferredTaskName;
      return canonical;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'he'));
}

function deepEqualSnapshots(a: ParticipantSnapshot[], b: ParticipantSnapshot[]): boolean {
  const na = normalizeSnapshots(a);
  const nb = normalizeSnapshots(b);
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) {
    if (JSON.stringify(na[i]) !== JSON.stringify(nb[i])) return false;
  }
  return true;
}

/** Load a workbook, mutate, re-serialize — for negative tests. */
async function loadWorkbook(blob: Blob): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const buf = await blobToArrayBuffer(blob);
  await wb.xlsx.load(buf);
  return wb;
}

async function workbookToArrayBuffer(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  const buf = await wb.xlsx.writeBuffer();
  // Always return a clean ArrayBuffer copy so SharedArrayBuffer and node
  // Buffer objects work consistently across versions.
  const view = new Uint8Array(buf as ArrayBuffer);
  const copy = new ArrayBuffer(view.byteLength);
  new Uint8Array(copy).set(view);
  return copy;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

export async function runParticipantSetXlsxTests(assert: AssertFn): Promise<void> {
  console.log('\n── Participant Set XLSX ────────────');

  // ── Round trip #1: full sample ───────────────────────────────────────
  {
    const pset = buildSamplePset();
    const result = await roundTrip(pset);
    assert(result.ok === true, 'RT1: parse ok');
    if (result.ok) {
      assert(
        result.pset.name === pset.name && result.pset.description === pset.description,
        'RT1: name/description preserved',
      );
      assert(result.pset.participants.length === pset.participants.length, 'RT1: participant count preserved');
      assert(
        deepEqualSnapshots(result.pset.participants, pset.participants),
        'RT1: snapshots deep-equal after normalization',
      );
      assert(
        result.pset.certificationCatalog.length === pset.certificationCatalog.length,
        'RT1: cert catalog count preserved',
      );
      assert(
        (result.pset.pakalCatalog ?? []).length === (pset.pakalCatalog ?? []).length,
        'RT1: pakal catalog count preserved',
      );
    }
  }

  // ── Round trip #2: empty set ─────────────────────────────────────────
  {
    const pset = buildSamplePset({ participants: [], name: 'ריק' });
    const result = await roundTrip(pset);
    assert(result.ok === true, 'RT2: empty set parses');
    if (result.ok) {
      assert(result.pset.participants.length === 0, 'RT2: zero participants');
    }
  }

  // ── Round trip #3: no pakal catalog ──────────────────────────────────
  {
    const pset = buildSamplePset({
      pakalCatalog: [],
      participants: [
        {
          name: 'בודד',
          level: Level.L2,
          certifications: [],
          group: 'קבוצה א',
          dateUnavailability: [],
        },
      ],
    });
    const result = await roundTrip(pset);
    assert(result.ok === true, 'RT3: set with empty pakal catalog parses');
    if (result.ok) {
      assert((result.pset.pakalCatalog ?? []).length === 0, 'RT3: empty pakal catalog preserved');
    }
  }

  // ── Negative: missing meta sheet ─────────────────────────────────────
  {
    const pset = buildSamplePset();
    const blob = await generateParticipantSetXlsx(pset);
    const wb = await loadWorkbook(blob);
    wb.removeWorksheet(wb.getWorksheet(SHEET_META)!.id);
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(
      result.ok === false && result.errors.some((e) => e.message.includes(SHEET_META)),
      'NEG: missing מטא sheet rejected',
    );
  }

  // ── Negative: wrong format marker ────────────────────────────────────
  {
    const pset = buildSamplePset();
    const blob = await generateParticipantSetXlsx(pset);
    const wb = await loadWorkbook(blob);
    const meta = wb.getWorksheet(SHEET_META)!;
    meta.getCell('B1').value = 'something-else';
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(
      result.ok === false && result.errors.some((e) => e.message.includes('אינו קובץ סט משתתפים')),
      'NEG: wrong format marker rejected',
    );
  }

  // ── Negative: wrong schema version ───────────────────────────────────
  {
    const pset = buildSamplePset();
    const blob = await generateParticipantSetXlsx(pset);
    const wb = await loadWorkbook(blob);
    const meta = wb.getWorksheet(SHEET_META)!;
    meta.getCell('B2').value = 99;
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(
      result.ok === false && result.errors.some((e) => e.message.includes('סכמה')),
      'NEG: wrong schema version rejected',
    );
  }

  // ── Negative: formula injection in name cell ─────────────────────────
  {
    const pset = buildSamplePset();
    const blob = await generateParticipantSetXlsx(pset);
    const wb = await loadWorkbook(blob);
    const ws = wb.getWorksheet(SHEET_PARTICIPANTS)!;
    ws.getCell('A2').value = { formula: 'SUM(A1:A3)', result: 0 };
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(result.ok === false && result.errors.some((e) => e.message.includes('נוסחה')), 'NEG: formula cell rejected');
  }

  // ── Negative: duplicate participant name (case-insensitive) ─────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    const ws = wb.getWorksheet(SHEET_PARTICIPANTS)!;
    // Overwrite row 3 (second participant) with the same name as row 2
    // (first participant). This guarantees a duplicate without depending
    // on exceljs's addRow() semantics for empty-template rows.
    const rawA2 = ws.getCell('A2').value;
    const dupName = typeof rawA2 === 'string' ? rawA2 : 'אורן';
    ws.getCell('A3').value = dupName;
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(
      result.ok === false && result.errors.some((e) => e.message.includes('חוזר')),
      'NEG: duplicate participant name rejected',
    );
  }

  // ── Negative: invalid level L1 ───────────────────────────────────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    const ws = wb.getWorksheet(SHEET_PARTICIPANTS)!;
    ws.getCell('C2').value = 'L1';
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(result.ok === false && result.errors.some((e) => e.message.includes('רמה')), 'NEG: L1 rejected');
  }

  // ── Negative: invalid day name ───────────────────────────────────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    const ws = wb.getWorksheet(SHEET_UNAVAILABILITY)!;
    // Find first data row and replace the day name.
    if (ws.actualRowCount >= 2) {
      ws.getCell('B2').value = 'שמיני';
      const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
      assert(
        result.ok === false && result.errors.some((e) => e.message.includes('יום')),
        'NEG: invalid day name rejected',
      );
    }
  }

  // ── Negative: hour out of range ──────────────────────────────────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    const ws = wb.getWorksheet(SHEET_UNAVAILABILITY)!;
    // Find a non-allDay row to corrupt. The sample has a non-allDay rule at some row.
    for (let r = 2; r <= ws.actualRowCount; r++) {
      const allDayVal = ws.getCell(`C${r}`).value;
      if (allDayVal !== 'כן') {
        ws.getCell(`D${r}`).value = 25;
        break;
      }
    }
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(result.ok === false && result.errors.some((e) => e.message.includes('שעת')), 'NEG: hour > 23 rejected');
  }

  // ── Positive: midnight crossing (endHour < startHour) accepted ──────
  // (Already exercised by RT1 — דנה has 22→6 rule. Assert explicitly.)
  {
    const pset = buildSamplePset();
    const result = await roundTrip(pset);
    assert(result.ok === true, 'MID: midnight-crossing rule round-trips');
    if (result.ok) {
      const dana = result.pset.participants.find((p) => p.name === 'דנה');
      const mid = dana?.dateUnavailability.find((r) => r.startHour === 22 && r.endHour === 6);
      assert(!!mid, 'MID: rule preserved with endHour < startHour');
    }
  }

  // ── Negative: כל היום=כן with populated hours is ACCEPTED ────────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    const ws = wb.getWorksheet(SHEET_UNAVAILABILITY)!;
    // Find the allDay row and add bogus hours.
    for (let r = 2; r <= ws.actualRowCount; r++) {
      if (ws.getCell(`C${r}`).value === 'כן') {
        ws.getCell(`D${r}`).value = 3;
        ws.getCell(`E${r}`).value = 7;
        break;
      }
    }
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(result.ok === true, 'ALL-DAY: populated hours with all-day=yes accepted');
  }

  // ── Negative: notWith self-reference ─────────────────────────────────
  {
    const pset = buildSamplePset();
    // Force a self-reference by mutating before export.
    pset.participants[0].notWithIds = [pset.participants[0].name];
    const blob = await generateParticipantSetXlsx(pset);
    const result = await parseParticipantSetXlsx(await blobToArrayBuffer(blob));
    assert(
      result.ok === false && result.errors.some((e) => e.message.includes('עצמו')),
      'NEG: notWith self-reference rejected',
    );
  }

  // ── Negative: notWith unresolved name ────────────────────────────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    const ws = wb.getWorksheet(SHEET_PARTICIPANTS)!;
    // Find the notWith column (header text = 'לא עם') in row 1.
    let notWithCol = -1;
    for (let c = 1; c <= ws.actualColumnCount; c++) {
      if (ws.getCell(1, c).value === 'לא עם') {
        notWithCol = c;
        break;
      }
    }
    if (notWithCol > 0) {
      ws.getCell(2, notWithCol).value = 'שם_לא_קיים';
      const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
      assert(
        result.ok === false && result.errors.some((e) => e.message.includes('לא ידוע')),
        'NEG: notWith unresolved name rejected',
      );
    }
  }

  // ── Security: too-large file ─────────────────────────────────────────
  {
    const buf = new ArrayBuffer(6 * 1024 * 1024);
    const result = await parseParticipantSetXlsx(buf);
    assert(result.ok === false && result.errors.some((e) => e.message.includes('5MB')), 'SEC: > 5MB rejected');
  }

  // ── Security: bad magic bytes ────────────────────────────────────────
  {
    const buf = new ArrayBuffer(128);
    new Uint8Array(buf).set([0x4d, 0x5a, 0x90, 0x00]); // MZ — Windows PE header
    const result = await parseParticipantSetXlsx(buf);
    assert(
      result.ok === false && result.errors.some((e) => e.message.includes('Excel')),
      'SEC: non-zip magic bytes rejected',
    );
  }

  // ── Catalog: new cert tracked for app merge ──────────────────────────
  {
    const customCerts: CertificationDefinition[] = [
      ...DEFAULT_CERTIFICATION_DEFINITIONS,
      { id: 'Extra', label: 'נוסף', color: '#123456' },
    ];
    const pset = buildSamplePset({
      certificationCatalog: customCerts,
      participants: [
        {
          name: 'מיכל',
          level: Level.L2,
          certifications: ['Extra'],
          group: 'קבוצה א',
          dateUnavailability: [],
        },
      ],
    });
    const result = await roundTrip(pset);
    assert(result.ok === true, 'CAT: custom cert round-trips');
    if (result.ok) {
      assert(
        result.meta.newCertsForApp.some((c) => c.id === 'Extra'),
        'CAT: custom cert present in meta.newCertsForApp',
      );
      assert(
        result.pset.participants[0].certifications.includes('Extra'),
        'CAT: custom cert id preserved on participant',
      );
    }
  }

  // ── Row cap: 201 rows rejected ───────────────────────────────────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    const ws = wb.getWorksheet(SHEET_PARTICIPANTS)!;
    // Stuff the sheet with rows past the cap.
    const startRow = ws.actualRowCount + 1;
    for (let i = 0; i < MAX_PARTICIPANT_ROWS + 1; i++) {
      const r = startRow + i;
      ws.getCell(`A${r}`).value = `גיבוי_${i}`;
      ws.getCell(`B${r}`).value = 'קבוצה א';
      ws.getCell(`C${r}`).value = 'L2';
    }
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(
      result.ok === false && result.errors.some((e) => e.message.includes('שורות משתתפים')),
      'CAP: > 200 participant rows rejected',
    );
  }

  // ── Extra sheet ignored silently ─────────────────────────────────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    wb.addWorksheet('הערות');
    const result = await parseParticipantSetXlsx(await workbookToArrayBuffer(wb));
    assert(result.ok === true, 'EXTRA: extra sheet name ignored');
  }

  // ── Catalog sheet present and parseable ──────────────────────────────
  {
    const blob = await generateParticipantSetXlsx(buildSamplePset());
    const wb = await loadWorkbook(blob);
    const certWs = wb.getWorksheet(SHEET_CERTS)!;
    const pakalWs = wb.getWorksheet(SHEET_PAKALS)!;
    assert(certWs.actualRowCount >= 2, 'SHEETS: cert catalog has rows');
    assert(pakalWs.actualRowCount >= 2, 'SHEETS: pakal catalog has rows');
    const meta = wb.getWorksheet(SHEET_META)!;
    assert(meta.getCell('B1').value === FORMAT_MARKER, 'SHEETS: format marker set');
    assert(Number(meta.getCell('B2').value) === SCHEMA_VERSION, 'SHEETS: schema version set');
  }

  // ── Template mode: empty set name rejected on import ────────────────
  {
    const pset = buildSamplePset({ name: '' });
    const blob = await generateParticipantSetXlsx(pset, { templateMode: true });
    const result = await parseParticipantSetXlsx(await blobToArrayBuffer(blob));
    assert(
      result.ok === false && result.errors.some((e) => e.message.includes('שם הסט')),
      'TPL: empty set name rejected on import',
    );
  }
}
