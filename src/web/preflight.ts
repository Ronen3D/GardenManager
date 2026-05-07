/**
 * Preflight Validator — web wrapper.
 *
 * Drives the "מוכנות לשיבוץ" chip, the per-template badges in the Task Rules
 * tab, and the Generate button's disabled state on the Schedule tab. The
 * actual checks live in `../shared/preflight-core.ts` (Node-testable).
 *
 * Cost: synchronous; ~10–80ms for realistic configs. The render layer is
 * expected to call `runPreflight()` once per `renderAll` and pass the result
 * down to per-tab renderers — see app.ts:renderAll.
 */

import type { PreflightResult } from '../models/types';
import { runPreflightWithInputs } from '../shared/preflight-core';
import {
  getAllOneTimeTasks,
  getAllParticipants,
  getAllRestRules,
  getAllTaskTemplates,
  getCertificationDefinitions,
  getDayStartHour,
  getDisabledHCSet,
  getScheduleDate,
  getScheduleDays,
} from './config-store';

export function runPreflight(): PreflightResult {
  return runPreflightWithInputs({
    participants: getAllParticipants(),
    templates: getAllTaskTemplates(),
    oneTimeTasks: getAllOneTimeTasks(),
    scheduleStart: getScheduleDate(),
    numDays: getScheduleDays(),
    dayStartHour: getDayStartHour(),
    disabledHC: getDisabledHCSet(),
    restRules: getAllRestRules(),
    certifications: getCertificationDefinitions().map((c) => ({ id: c.id, label: c.label })),
  });
}
