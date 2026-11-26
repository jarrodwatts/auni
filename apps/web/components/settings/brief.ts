import type { BriefSchedule } from "@auni/shared";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;

/**
 * The brief's schedule as Settings offers it: every day, weekdays, off, and the two it only
 * shows when the owner set one in chat (some days of the week, a day of the month).
 */
export type BriefChoice = "day" | "weekdays" | "days" | "month" | "off";

export function briefChoice(brief: BriefSchedule | null): BriefChoice {
  if (!brief) return "off";
  if (brief.every === "day" || brief.every === "month") return brief.every;
  const weekdays =
    brief.every.length === WEEKDAYS.length && WEEKDAYS.every((day) => brief.every.includes(day));
  return weekdays ? "weekdays" : "days";
}

/** The schedule a choice and a time make, keeping the days or the date `was` had. */
export function briefFor(
  choice: BriefChoice,
  at: string,
  was: BriefSchedule | null,
): BriefSchedule | null {
  switch (choice) {
    case "off":
      return null;
    case "day":
      return { every: "day", at };
    case "month":
      return { every: "month", day: was?.every === "month" ? was.day : 1, at };
    case "days":
      return was && Array.isArray(was.every)
        ? { every: was.every, at }
        : { every: [...WEEKDAYS], at };
    case "weekdays":
      return { every: [...WEEKDAYS], at };
  }
}
