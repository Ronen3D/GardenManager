/**
 * Participant Capacity Calculator
 *
 * Computes per-participant available hours within a schedule window,
 * accounting for both AvailabilityWindow ranges and DateUnavailability holes.
 * Used to scale workload targets proportionally to actual availability.
 */

import { Participant, ParticipantCapacity } from '../models/types';
import { dateKey } from './date-utils';

/**
 * Compute available hours for a single calendar day, given a participant's
 * availability windows and date-unavailability rules.
 *
 * @param day       The calendar date to evaluate (time portion ignored)
 * @param participant The participant with availability + dateUnavailability
 * @returns Available hours on that day (0–24)
 */
function computeDayAvailableHours(day: Date, participant: Participant): number {
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999);
  const dayStartMs = dayStart.getTime();
  const dayEndMs = dayEnd.getTime() + 1; // exclusive end = midnight next day

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

  // 2. Subtract date-unavailability holes
  const dk = dateKey(day);
  const dayOfWeek = day.getDay(); // 0=Sun … 6=Sat

  for (const rule of participant.dateUnavailability) {
    // Check if rule applies to this day
    let applies = false;
    if (rule.specificDate && rule.specificDate === dk) {
      applies = true;
    } else if (rule.dayOfWeek !== undefined && rule.dayOfWeek === dayOfWeek && !rule.specificDate) {
      applies = true;
    }

    if (!applies) continue;

    if (rule.allDay) {
      // Entire day unavailable
      return 0;
    }

    // Partial-day unavailability: subtract startHour..endHour
    const unavailHours = rule.endHour - rule.startHour;
    if (unavailHours > 0) {
      availableHours = Math.max(0, availableHours - unavailHours);
    }
  }

  return availableHours;
}

/**
 * Compute the capacity for a single participant within a schedule window.
 *
 * @param participant    The participant
 * @param scheduleStart  Start of the schedule window (inclusive)
 * @param scheduleEnd    End of the schedule window (exclusive)
 * @returns ParticipantCapacity with totalAvailableHours and dailyAvailableHours
 */
export function computeParticipantCapacity(
  participant: Participant,
  scheduleStart: Date,
  scheduleEnd: Date,
): ParticipantCapacity {
  const dailyAvailableHours = new Map<string, number>();
  let totalAvailableHours = 0;

  // Iterate over each calendar day in the schedule window
  const cursor = new Date(scheduleStart.getFullYear(), scheduleStart.getMonth(), scheduleStart.getDate());
  const endDay = new Date(scheduleEnd.getFullYear(), scheduleEnd.getMonth(), scheduleEnd.getDate());

  while (cursor <= endDay) {
    const hours = computeDayAvailableHours(cursor, participant);
    const dk = dateKey(cursor);
    dailyAvailableHours.set(dk, hours);
    totalAvailableHours += hours;

    // Advance to next day
    cursor.setDate(cursor.getDate() + 1);
  }

  return { totalAvailableHours, dailyAvailableHours };
}

/**
 * Compute capacities for all participants within a schedule window.
 *
 * @param participants   All participants
 * @param scheduleStart  Start of the schedule window
 * @param scheduleEnd    End of the schedule window
 * @returns Map from participant ID to ParticipantCapacity
 */
export function computeAllCapacities(
  participants: Participant[],
  scheduleStart: Date,
  scheduleEnd: Date,
): Map<string, ParticipantCapacity> {
  const result = new Map<string, ParticipantCapacity>();
  for (const p of participants) {
    result.set(p.id, computeParticipantCapacity(p, scheduleStart, scheduleEnd));
  }
  return result;
}
