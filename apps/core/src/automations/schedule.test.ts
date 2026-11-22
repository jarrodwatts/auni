import { describe as group, expect, it } from "vitest";

import {
  clockConditionSchema,
  describe,
  instantOf,
  nextAfter,
  onTheirClock,
  type ClockCondition,
} from "./schedule.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (instant: number | null) => (instant === null ? null : new Date(instant).toISOString());

/** The next `count` times after `from`, as UTC. */
function times(condition: ClockCondition, zone: string, from: string, count: number, setUp = from) {
  const out: (string | null)[] = [];
  let after: number | null = at(from);
  for (let index = 0; index < count && after !== null; index += 1) {
    after = nextAfter(condition, zone, after, at(setUp));
    out.push(iso(after));
  }
  return out;
}

group("a time of day through a change of the clocks", () => {
  const fivePm: ClockCondition = { every: "day", at: "17:00" };

  it("stays 5pm in New York as its clocks go forward and back", () => {
    // Clocks go forward on 8 March 2026 (EST, -5, to EDT, -4) and back on 1 November.
    expect(times(fivePm, "America/New_York", "2026-03-07T12:00:00Z", 2)).toEqual([
      "2026-03-07T22:00:00.000Z",
      "2026-03-08T21:00:00.000Z",
    ]);
    expect(times(fivePm, "America/New_York", "2026-10-31T12:00:00Z", 2)).toEqual([
      "2026-10-31T21:00:00.000Z",
      "2026-11-01T22:00:00.000Z",
    ]);
  });

  it("stays 5pm on Fridays in Sydney as its clocks go forward and back", () => {
    // Sydney's clocks go back on 5 April 2026 (AEDT, +11, to AEST, +10) and forward on 4 October.
    const fridays: ClockCondition = { every: ["fri"], at: "17:00" };
    expect(times(fridays, "Australia/Sydney", "2026-03-30T00:00:00Z", 2)).toEqual([
      "2026-04-03T06:00:00.000Z",
      "2026-04-10T07:00:00.000Z",
    ]);
    expect(times(fridays, "Australia/Sydney", "2026-09-28T00:00:00Z", 2)).toEqual([
      "2026-10-02T07:00:00.000Z",
      "2026-10-09T06:00:00.000Z",
    ]);
  });

  it("takes a time the clocks skip as the same time after the jump, and one they pass twice as the first", () => {
    const halfTwo = Date.UTC(2026, 2, 8, 2, 30);
    expect(iso(instantOf(halfTwo, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(instantOf(Date.UTC(2026, 10, 1, 1, 30), "America/New_York"))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    // In Sydney 2:30 am is skipped on 4 October and passed twice on 5 April.
    expect(iso(instantOf(Date.UTC(2026, 9, 4, 2, 30), "Australia/Sydney"))).toBe(
      "2026-10-03T16:30:00.000Z",
    );
    expect(iso(instantOf(Date.UTC(2026, 3, 5, 2, 30), "Australia/Sydney"))).toBe(
      "2026-04-04T15:30:00.000Z",
    );
    // A daily 2:30 am comes once on each of those nights.
    const early: ClockCondition = { every: "day", at: "02:30" };
    expect(times(early, "Australia/Sydney", "2026-04-03T17:00:00Z", 3)).toEqual([
      "2026-04-04T15:30:00.000Z",
      "2026-04-05T16:30:00.000Z",
      "2026-04-06T16:30:00.000Z",
    ]);
    expect(times(early, "Australia/Sydney", "2026-10-02T17:00:00Z", 2)).toEqual([
      "2026-10-03T16:30:00.000Z",
      "2026-10-04T15:30:00.000Z",
    ]);
  });

  it("counts every N hours in real hours, through a change of the clocks", () => {
    const every4h: ClockCondition = { every: "4h" };
    expect(times(every4h, "Australia/Sydney", "2026-04-04T13:00:00Z", 3)).toEqual([
      "2026-04-04T17:00:00.000Z",
      "2026-04-04T21:00:00.000Z",
      "2026-04-05T01:00:00.000Z",
    ]);
    // Counted from when it was set up, wherever the count is picked up.
    expect(times(every4h, "UTC", "2026-04-05T02:00:00Z", 1, "2026-04-04T13:00:00Z")).toEqual([
      "2026-04-05T05:00:00.000Z",
    ]);
  });
});

group("days of the month", () => {
  it("takes a day past a month's end as its last day", () => {
    const the31st: ClockCondition = { every: "month", day: 31, at: "09:00" };
    expect(times(the31st, "UTC", "2027-01-01T00:00:00Z", 4)).toEqual([
      "2027-01-31T09:00:00.000Z",
      "2027-02-28T09:00:00.000Z",
      "2027-03-31T09:00:00.000Z",
      "2027-04-30T09:00:00.000Z",
    ]);
  });

  it("has a leap day only in a leap year", () => {
    const the29th: ClockCondition = { every: "month", day: 29, at: "09:00" };
    expect(times(the29th, "Australia/Sydney", "2027-02-01T00:00:00Z", 1)).toEqual([
      "2027-02-27T22:00:00.000Z",
    ]);
    expect(times(the29th, "Australia/Sydney", "2028-02-01T00:00:00Z", 2)).toEqual([
      "2028-02-28T22:00:00.000Z",
      "2028-03-28T22:00:00.000Z",
    ]);
    expect(clockConditionSchema.safeParse({ at: "2028-02-29 09:00" }).success).toBe(true);
    expect(clockConditionSchema.safeParse({ at: "2027-02-29 09:00" }).success).toBe(false);
    expect(times({ at: "2028-02-29 09:00" }, "UTC", "2028-01-01T00:00:00Z", 2)).toEqual([
      "2028-02-29T09:00:00.000Z",
      null,
    ]);
  });

  it("reaches the new year from New Year's Eve", () => {
    expect(
      times(
        { every: "month", day: 1, at: "00:00:30" },
        "Australia/Sydney",
        "2026-12-31T12:00:00Z",
        1,
      ),
    ).toEqual(["2026-12-31T13:00:30.000Z"]);
  });
});

group("a condition", () => {
  it("is one of the shapes its guide shows, and nothing else", () => {
    for (const shape of [
      { at: "2026-11-21 17:00" },
      { at: "2026-11-21T17:00:30" },
      { every: "day", at: "08:00" },
      { every: ["mon", "fri"], at: "17:00" },
      { every: "month", day: 1, at: "09:00" },
      { every: "4h" },
    ])
      expect(clockConditionSchema.safeParse(shape).success, JSON.stringify(shape)).toBe(true);
    for (const shape of [
      { at: "5pm" },
      { every: "friday", at: "17:00" },
      { every: ["fri"], at: "24:00" },
      { every: "25h" },
      { every: "4h", at: "09:00" },
      { every: "month", at: "09:00" },
      { cron: "0 17 * * 5" },
    ])
      expect(clockConditionSchema.safeParse(shape).success, JSON.stringify(shape)).toBe(false);
  });

  it("reads in plain words", () => {
    expect(describe({ every: ["fri"], at: "17:00" })).toBe("Every Friday at 5:00 pm");
    expect(describe({ every: ["fri", "mon", "wed"], at: "09:05" })).toBe(
      "Every Monday, Wednesday and Friday at 9:05 am",
    );
    expect(describe({ every: ["mon", "tue", "wed", "thu", "fri"], at: "12:00" })).toBe(
      "Every weekday at 12:00 pm",
    );
    expect(describe({ every: "day", at: "00:15" })).toBe("Every day at 12:15 am");
    expect(describe({ every: "month", day: 22, at: "18:30:15" })).toBe(
      "On the 22nd of every month at 6:30:15 pm",
    );
    expect(describe({ every: "1h" })).toBe("Every hour");
    expect(describe({ every: "6h" })).toBe("Every 6 hours");
    expect(describe({ at: "2026-11-20 17:00" })).toBe(
      "Once, on Friday 20 November 2026 at 5:00 pm",
    );
    expect(onTheirClock(at("2026-11-20T06:00:00Z"), "Australia/Sydney")).toBe(
      "Friday 20 November 2026, 5:00 pm",
    );
  });
});
