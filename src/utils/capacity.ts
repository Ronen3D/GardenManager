/**
 * Participant Capacity Calculator
 *
 * Computes per-participant available hours within a schedule window,
 * based on the participant's AvailabilityWindow ranges.
 *
 * Recurring weekday unavailability rules are expected to be pre-materialized
 * into the availability windows before reaching this module (see
 * config-store's computeAvailability()). This avoids double-subtraction.
 */

import { Participant, ParticipantCapacity } from '../models/types';
import { operationalDateKey } from './date-utils';

/**
 * Compute available hours for a single operational day, given a participant's
 * availability windows.
 *
 * @param opDayStart  The start of the operational day (dayStartHour on some calendar date)
 * @param participant The participant with materialized availability windows
 * @returns Available hours on that operational day (0–24)
 */
function computeDayAvailableHours(opDayStart: Date, participant: Participant): number {
  const dayStartMs = opDayStart.getTime();
  const dayEndMs = dayStartMs + 24 * 3_600_000; // exactly 24 hours

  // 1. Compute hours covered by availability windows on this day
  let availableHours = 0;
  for (const w of participant.availability) {
    const overlapStart = Math.max(dayStartMs, w.start.getTime());
    const overlapEnd = Math.min(dayEndMs, w.end.getTime());
    if (overlapEnd > overlapStart) {
      availableHours += (overlapEnd - overlapStart) / 3_600_000;
    }
  }

  if (availableHours <= 0) return 0;

  // NOTE: Recurring weekday unavailability rules are NOT re-applied here.
  // In the web app, participant.availability already has unavailability
  // holes carved out by config-store's computeAvailability(). Re-subtracting
  // dateUnavailability would double-count, underestimating capacity.
  // Library consumers constructing Participant objects manually should
  // pre-process dateUnavailability into their availability windows.

  return availableHours;
}

/**
 * Compute the capacity for a single participant within a schedule window.
 *
 * @param participant    The participant
 * @param scheduleStart  Start of the schedule window (inclusive)
 * @param scheduleEnd    End of the schedule window (exclusive)
 * @param dayStartHour   The operational day boundary hour (0–23)
 * @returns ParticipantCapacity with totalAvailableHours and dailyAvailableHours
 */
export function computeParticipantCapacity(
  participant: Participant,
  scheduleStart: Date,
  scheduleEnd: Date,
  dayStartHour: number = 5,
): ParticipantCapacity {
  const dailyAvailableHours = new Map<string, number>();
  let totalAvailableHours = 0;

  // Iterate over each operational day in the schedule window.
  // An operational day starts at dayStartHour on a calendar date and runs 24 hours.
  // If scheduleStart falls before today's dayStartHour (e.g. a task stamped at
  // 05:00 on day 1 with dayStartHour=6), that timestamp belongs to the previous
  // calendar day's operational period — the cursor must start there so the map
  // key aligns with operationalDateKey() for such tasks.
  const cursor = new Date(
    scheduleStart.getFullYear(), scheduleStart.getMonth(), scheduleStart.getDate(),
    dayStartHour, 0, 0, 0,
  );
  if (cursor.getTime() > scheduleStart.getTime()) {
    cursor.setDate(cursor.getDate() - 1);
  }
  const endMs = scheduleEnd.getTime();

  while (cursor.getTime() < endMs) {
    const hours = computeDayAvailableHours(cursor, participant);
    const dk = operationalDateKey(cursor, dayStartHour);
    dailyAvailableHours.set(dk, hours);
    totalAvailableHours += hours;

    // Advance to next operational day (24 hours)
    cursor.setTime(cursor.getTime() + 24 * 3_600_000);
  }

  return { totalAvailableHours, dailyAvailableHours };
}

/**
 * Compute capacities for all participants within a schedule window.
 *
 * @param participants   All participants
 * @param scheduleStart  Start of the schedule window
 * @param scheduleEnd    End of the schedule window
 * @param dayStartHour   The operational day boundary hour (0–23)
 * @returns Map from participant ID to ParticipantCapacity
 */
export function computeAllCapacities(
  participants: Participant[],
  scheduleStart: Date,
  scheduleEnd: Date,
  dayStartHour: number = 5,
): Map<string, ParticipantCapacity> {
  const result = new Map<string, ParticipantCapacity>();
  for (const p of participants) {
    result.set(p.id, computeParticipantCapacity(p, scheduleStart, scheduleEnd, dayStartHour));
  }
  return result;
}
