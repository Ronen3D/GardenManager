/**
 * Task Library - Factory functions to create properly-typed Task instances
 * with all slot requirements and constraints.
 */
import { Task, TimeBlock } from '../models/types';
/**
 * Create 3 Adanit shift tasks for a given base date.
 * Shifts: 06:00-14:00, 14:00-22:00, 22:00-06:00 (next day).
 */
export declare function createAdanitTasks(baseDate: Date): Task[];
export declare function createHamamaTask(timeBlock: TimeBlock): Task;
export declare function createShemeshTask(timeBlock: TimeBlock): Task;
export declare function createMamteraTask(baseDate: Date): Task;
export declare function createKarovTask(timeBlock: TimeBlock): Task;
export declare function createKarovitTask(timeBlock: TimeBlock, requiredCount?: number): Task;
export declare function createArugaTask(timeBlock: TimeBlock, label?: string): Task;
/**
 * Generate a full day's task set for a given base date.
 * Creates:
 *  - 3 Adanit shifts
 *  - 2 Hamama blocks (day/night 12h each)
 *  - 6 Shemesh blocks (4h each covering 24h)
 *  - 1 Mamtera
 *  - 3 Karov blocks (8h each)
 *  - 3 Karovit blocks (8h each)
 *  - 2 Aruga (morning 06:00-07:30, evening 18:00-19:30)
 */
export declare function generateDailyTasks(baseDate: Date): Task[];
//# sourceMappingURL=task-definitions.d.ts.map