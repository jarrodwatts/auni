import { describe, expect, it } from "vitest";

import type { SourceBatch, SourceWatch } from "../contract.ts";
import type { ClockCondition } from "../../automations/schedule.ts";
import { due, runClock, type ClockWorld } from "./source.ts";

// The owner is in Sydney (+11 in November). Friday 20 November 2026, 5pm there is 06:00 UTC.
const ZONE = "Australia/Sydney";
const at = (iso: string) => Date.parse(iso);
const FRIDAY_5PM = at("2026-11-20T06:00:00Z");
const HOUR = 3_600_000;

const fridays: ClockCondition = { every: ["fri"], at: "17:00" };

function watch(id: string, condition: ClockCondition, setUp = "2026-11-16T00:00:00Z"): SourceWatch {
  return { id, condition, ref: null, since: new Date(setUp) };
}

/** Passes at each moment in turn, one cursor kept between them: the fires each told. */
function passes(watches: readonly SourceWatch[], moments: readonly number[]) {
  const told = {};
  return moments.map((now) => due(watches, told, ZONE, now));
}

describe("the clock's passes", () => {
  it("fires once at its time, on time, and not before", () => {
    const [before, onTime, again] = passes(
      [watch("w", fridays)],
      [FRIDAY_5PM - 1_000, FRIDAY_5PM + 400, FRIDAY_5PM + 1_400],
    );
    expect(before).toEqual([]);
    expect(again).toEqual([]);
    expect(onTime).toEqual([
      {
        watchId: "w",
        id: `w:${FRIDAY_5PM}`,
        at: new Date(FRIDAY_5PM),
        report: {
          schedule: "Every Friday at 5:00 pm",
          time: `Friday 20 November 2026, 5:00 pm (${ZONE})`,
          nextTime: "Friday 27 November 2026, 5:00 pm",
        },
      },
    ]);
  });

  it("tells a time missed while Auni was off once, late, saying how late", () => {
    // Asleep from Friday morning; opened at 8pm.
    const [, woke] = passes([watch("w", fridays)], [FRIDAY_5PM - 8 * HOUR, FRIDAY_5PM + 3 * HOUR]);
    expect(woke).toHaveLength(1);
    expect(woke![0]).toMatchObject({
      id: `w:${FRIDAY_5PM}`,
      at: new Date(FRIDAY_5PM),
      late: true,
      report: { late: "Auni was off then, and is telling it 3 hours late." },
    });
  });

  it("lets a schedule's time go untold once it is stale, and never tells a backlog", () => {
    // Opened on Saturday morning: 15 hours on, past the 12 a missed Friday is told within.
    const [, saturday, sunday] = passes(
      [watch("w", fridays)],
      [FRIDAY_5PM - HOUR, FRIDAY_5PM + 15 * HOUR, FRIDAY_5PM + 40 * HOUR],
    );
    expect(saturday).toEqual([]);
    expect(sunday).toEqual([]);

    // Asleep three Fridays; opened an hour after the third: that one, saying two were missed.
    const threeWeeks = FRIDAY_5PM + 14 * 24 * HOUR;
    const [, back] = passes([watch("w", fridays)], [FRIDAY_5PM - HOUR, threeWeeks + HOUR]);
    expect(back!.map(({ id }) => id)).toEqual([`w:${threeWeeks}`]);
    expect(back![0]!.report).toMatchObject({ earlierTimesMissed: 2 });

    // Every 4 hours: a time missed by more than half the wait to the next goes untold.
    const every4h = watch("h", { every: "4h" }, "2026-11-20T00:00:00Z");
    const fourAm = at("2026-11-20T04:00:00Z");
    expect(passes([every4h], [fourAm - 1_000, fourAm + HOUR])[1]).toHaveLength(1);
    expect(passes([every4h], [fourAm - 1_000, fourAm + 3 * HOUR])[1]).toEqual([]);
  });

  it("tells a one-time watch however late, since it is the only time it has", () => {
    const once = watch("o", { at: "2026-11-20 17:00" });
    const [, days] = passes([once], [FRIDAY_5PM - HOUR, FRIDAY_5PM + 3 * 24 * HOUR]);
    expect(days![0]).toMatchObject({
      late: true,
      report: { late: "Auni was off then, and is telling it 3 days late." },
    });
    expect(days![0]!.report).not.toHaveProperty("nextTime");
  });

  it("counts a watch first seen from when it was set up, and a changed one from the change", () => {
    // Set up on Friday at 4pm, first seen after 5pm: its first Friday counts.
    const setUpAt4 = watch("w", fridays, "2026-11-20T05:00:00Z");
    expect(passes([setUpAt4], [FRIDAY_5PM + 10_000])[0]).toHaveLength(1);
    // Set up at 5:30pm: this Friday was already gone.
    const setUpAfter = watch("w", fridays, "2026-11-20T06:30:00Z");
    expect(passes([setUpAfter], [FRIDAY_5PM + HOUR])[0]).toEqual([]);

    // Changed at 6pm to 5:30pm: it has passed, and it doesn't fire for that.
    const told = {};
    expect(due([watch("w", fridays)], told, ZONE, FRIDAY_5PM + 1_000)).toHaveLength(1);
    const changed = watch("w", { every: ["fri"], at: "17:30" });
    expect(due([changed], told, ZONE, FRIDAY_5PM + HOUR)).toEqual([]);
    const nextWeek = FRIDAY_5PM + 7 * 24 * HOUR + 30 * 60_000;
    expect(due([changed], told, ZONE, nextWeek).map(({ id }) => id)).toEqual([`w:${nextWeek}`]);
  });
});

describe("the clock's run", () => {
  it("catches up from its cursor after a restart, and tells nothing twice", async () => {
    const watches = [watch("w", fridays)];
    /** A run whose clock reads each moment in turn, one a pass, ending after the last. */
    async function run(cursor: string | null, moments: readonly number[]) {
      const stop = new AbortController();
      let pass = 0;
      const world: ClockWorld = {
        now: () => moments[pass]!,
        timeZone: async () => ZONE,
        wait: async () => {
          pass += 1;
          if (pass === moments.length) stop.abort();
        },
      };
      const batches: SourceBatch[] = [];
      const context = {
        watches: () => watches,
        refresh: async () => watches,
        cursor,
        since: null,
        signal: stop.signal,
      };
      for await (const batch of runClock(context, world)) batches.push(batch);
      return batches;
    }

    const first = await run(null, [FRIDAY_5PM - HOUR, FRIDAY_5PM - HOUR + 1_000]);
    // The watch's place is saved once, and not again while nothing moves.
    expect(first).toEqual([{ fires: [], cursor: expect.any(String) }]);

    // Stopped before 5pm and started again at 7pm: the Friday is told, late, once.
    const second = await run(first.at(-1)!.cursor, [FRIDAY_5PM + 2 * HOUR, FRIDAY_5PM + 3 * HOUR]);
    expect(second.flatMap(({ fires }) => fires).map(({ id, late }) => ({ id, late }))).toEqual([
      { id: `w:${FRIDAY_5PM}`, late: true },
    ]);
    const third = await run(second.at(-1)!.cursor, [FRIDAY_5PM + 4 * HOUR]);
    expect(third).toEqual([]);
  });
});
