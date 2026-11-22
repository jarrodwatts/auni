import { z } from "zod";

// The one way Auni says "at a time": a clock watch's condition (apps/clock/) and the brief's
// schedule (brief.ts) take these shapes, and this is the arithmetic of when one comes due. Times
// are the owner's own wall clock in their time zone, so "17:00" stays 5pm through a change of the
// clocks. Pure, with no clock of its own: every function is told the moment it reasons from.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Days of the week as a condition names them, in the order Date's getUTCDay counts them. */
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/u, 'a 24-hour time such as "17:00"')
  .describe('Their own time of day, 24-hour: "17:00"');

const moment = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}[ T]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/u,
    'a date and 24-hour time such as "2026-11-21 17:00"',
  )
  .refine((text) => realDay(text.slice(0, 10)), "a day the calendar has")
  .describe('A date and time on their own clock: "2026-11-21 17:00"');

/** Again and again at a time of day: daily, on chosen weekdays, or on a day of each month. */
export const scheduleSchema = z.union([
  z.strictObject({ every: z.literal("day"), at: time }),
  z.strictObject({ every: z.array(z.enum(DAYS)).min(1).max(7), at: time }),
  z.strictObject({ every: z.literal("month"), day: z.number().int().min(1).max(31), at: time }),
]);

export type Schedule = z.infer<typeof scheduleSchema>;

/** Once at a moment, on a schedule, or every N hours from when it is set up. */
export const clockConditionSchema = z.union([
  z.strictObject({ at: moment }),
  ...scheduleSchema.options,
  z.strictObject({
    every: z.string().regex(/^([1-9]|1\d|2[0-4])h$/u, 'hours from "1h" to "24h"'),
  }),
]);

export type ClockCondition = z.infer<typeof clockConditionSchema>;

/** The shapes a schedule takes, for the agent: the lines a clock watch's guide and the brief share. */
export const SCHEDULE_SHAPES = `- every day: {"every":"day","at":"08:00"}
- chosen weekdays: {"every":["fri"],"at":"17:00"}, or {"every":["mon","tue","wed","thu","fri"],"at":"09:30"}
- a day of the month: {"every":"month","day":1,"at":"09:00"}; a day past a month's end (31 in April) is that month's last day`;

/** "2026-02-29" names a day the calendar has (2028's, not 2027's). */
function realDay(day: string): boolean {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(year, month - 1, date));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date;
}

/** Milliseconds into the day of "17:00" or "17:00:30". */
function timeOfDay(text: string): number {
  const [hours, minutes, seconds = 0] = text.split(":").map(Number) as [number, number, number?];
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000;
}

// A wall-clock reading is written as the instant UTC would show it: 5pm on 21 November in their
// zone is Date.UTC(2026, 10, 21, 17). Converting between a reading and an instant is all there is
// to time zones here.

const formats = new Map<string, Intl.DateTimeFormat>();

/** What the wall clock in `zone` reads at `instant`. */
function wallAt(instant: number, zone: string): number {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(zone, format);
  }
  const part = Object.fromEntries(
    format.formatToParts(instant).map(({ type, value }) => [type, Number(value)]),
  );
  const second = Date.UTC(
    part.year!,
    part.month! - 1,
    part.day,
    part.hour,
    part.minute,
    part.second,
  );
  return second + (((instant % 1_000) + 1_000) % 1_000);
}

/**
 * The instant the wall clock in `zone` reads `wall`. A reading the clocks skip when they go
 * forward (2:30 am on that night) is taken as the same time after the jump (3:30 am), and one
 * they pass twice when they go back is the first.
 */
export function instantOf(wall: number, zone: string): number {
  // The clocks change at most once in two days, so the offsets a day either side are the only two.
  const before = wall - (wallAt(wall - DAY_MS, zone) - (wall - DAY_MS));
  const after = wall - (wallAt(wall + DAY_MS, zone) - (wall + DAY_MS));
  const read = [before, after].filter((instant) => wallAt(instant, zone) === wall);
  // Neither reads it: a skipped time, which the offset before the jump puts after it.
  return read.length > 0 ? Math.min(...read) : before;
}

/** The instant the owner's day holding `instant` began: midnight on their wall clock. */
export function dayStart(instant: number, zone: string): number {
  const wall = wallAt(instant, zone);
  return instantOf(wall - (wall % DAY_MS), zone);
}

/**
 * The first time the condition comes due after `after` (an instant), or null when it never does
 * again (a one-time watch whose moment has passed). An every-N-hours watch counts from `setUp`.
 */
export function nextAfter(
  condition: ClockCondition,
  zone: string,
  after: number,
  setUp: number,
): number | null {
  if (!("every" in condition)) {
    const instant = instantOf(Date.parse(`${condition.at.replace(" ", "T")}Z`), zone);
    return instant > after ? instant : null;
  }
  if (!("at" in condition)) {
    const step = Number.parseInt(condition.every, 10) * HOUR_MS;
    return setUp + Math.max(1, Math.floor((after - setUp) / step) + 1) * step;
  }
  const at = timeOfDay(condition.at);
  const today = wallAt(after, zone);
  // From the day before, since a time just past midnight may fall on the day before's wall date
  // after a change of the clocks; a month's last day is never more than 31 days on.
  for (let day = today - (today % DAY_MS) - DAY_MS; day < today + 32 * DAY_MS; day += DAY_MS) {
    if (!dueOn(condition, day)) continue;
    const instant = instantOf(day + at, zone);
    if (instant > after) return instant;
  }
  throw new Error("A schedule with no day in the next month.");
}

/** Whether a schedule comes due on the day starting at `day` (a wall-clock midnight). */
function dueOn(condition: ClockCondition, day: number): boolean {
  if (!("every" in condition) || condition.every === "day") return true;
  const date = new Date(day);
  if (Array.isArray(condition.every)) return condition.every.includes(DAYS[date.getUTCDay()]!);
  if (!("day" in condition)) return false;
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return date.getUTCDate() === Math.min(condition.day, lastDay);
}

/** Whether the condition comes due again and again, rather than once. */
export function recurs(condition: ClockCondition): boolean {
  return "every" in condition;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

/** "5:00 pm", "9:30 am", "5:00:30 pm". */
function clockTime(text: string): string {
  const [hours, minutes, seconds] = text.split(":").map(Number) as [number, number, number?];
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  const tail = seconds ? `:${String(seconds).padStart(2, "0")}` : "";
  return `${twelve}:${String(minutes).padStart(2, "0")}${tail} ${hours < 12 ? "am" : "pm"}`;
}

function ordinal(day: number): string {
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}

/** "Monday, Wednesday and Friday". */
function listed(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]!;
}

/** The condition in plain words: "Every Friday at 5:00 pm". */
export function describe(condition: ClockCondition): string {
  if (!("every" in condition)) {
    const [day, at] = condition.at.split(/[ T]/u) as [string, string];
    return `Once, on ${dayName(Date.parse(`${day}T00:00Z`))} at ${clockTime(at)}`;
  }
  if (!("at" in condition)) {
    const hours = Number.parseInt(condition.every, 10);
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  if (condition.every === "day") return `Every day at ${clockTime(condition.at)}`;
  if (Array.isArray(condition.every)) {
    const days = DAYS.filter((day) => (condition.every as string[]).includes(day));
    const named =
      days.length === 7
        ? "day"
        : days.join() === WEEKDAYS.join()
          ? "weekday"
          : listed(days.map((day) => DAY_NAMES[DAYS.indexOf(day)]!));
    return `Every ${named} at ${clockTime(condition.at)}`;
  }
  return "day" in condition
    ? `On the ${ordinal(condition.day)} of every month at ${clockTime(condition.at)}`
    : `Every day at ${clockTime(condition.at)}`;
}

/** "Friday 21 November 2026", for a wall-clock reading. */
function dayName(wall: number): string {
  const date = new Date(wall);
  const month = date.toLocaleDateString("en-US", { timeZone: "UTC", month: "long" });
  return `${DAY_NAMES[date.getUTCDay()]!} ${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

/** An instant as the owner's clock reads it: "Friday 21 November 2026, 5:00 pm". */
export function onTheirClock(instant: number, zone: string): string {
  const wall = wallAt(instant, zone);
  const date = new Date(wall);
  const at = `${date.getUTCHours()}:${date.getUTCMinutes()}:${date.getUTCSeconds()}`;
  return `${dayName(wall)}, ${clockTime(at)}`;
}
