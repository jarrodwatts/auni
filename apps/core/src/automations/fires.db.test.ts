import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { automationFires, automations, jobs, sourceCursors, threads } from "../db/schema.ts";
import { triageKind } from "../jobs/kinds.ts";
import type { Source, SourceBatch, SourceFire, SourceRun } from "../apps/contract.ts";
import { insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import {
  createAutomation,
  DAILY_AUTOMATION_WAKES,
  LIVE_AUTOMATIONS,
  listFires,
  recordFire,
} from "./automations.ts";
import { loadCursor, recordSourceFires, runSource, runSources } from "./sources.ts";

const triages = () => queued("triage");

// A source of the test's own, beside the real ones, for the hub's side of a run.
const fake = vi.hoisted(() => ({
  batches: [] as SourceBatch[],
  runs: [] as SourceRun[],
  /** What the run does once its batches are told, before it ends. */
  after: null as ((context: SourceRun) => Promise<void>) | null,
}));
vi.mock("../apps/registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../apps/registry.ts")>();
  const { z } = await import("zod");
  const source: Source = {
    guide: "Test watches.",
    condition: z.record(z.string(), z.unknown()),
    configured: () => true,
    async *run(context) {
      fake.runs.push(context);
      yield* fake.batches;
      await fake.after?.(context);
    },
  };
  const installed = { about: { id: "fake", name: "Fake" }, source };
  // Not set up: runSources doesn't start it.
  const unset = {
    about: { id: "unset", name: "Unset" },
    source: { ...source, configured: () => false },
  };
  return {
    ...real,
    sources: () => [installed, unset],
    sourceById: (id: string) => (id === "fake" ? installed : real.sourceById(id)),
  };
});

beforeEach(() => wipe(threads, automations, automationFires, sourceCursors, jobs));
afterEach(() => {
  vi.restoreAllMocks();
});

async function insertWatch(
  threadId: string,
  fields: Partial<typeof automations.$inferInsert> = {},
) {
  const [automation] = await db
    .insert(automations)
    .values({
      threadId,
      source: "fake",
      condition: { about: "HYPE" },
      description: "News on HYPE",
      note: "They hold HYPE.",
      repeat: "0",
      ...fields,
    })
    .returning();
  return automation!;
}

function fireOf(watchId: string, id: string, story?: string): SourceFire {
  return {
    watchId,
    id,
    at: new Date(),
    report: { said: id },
    ...(story ? { story } : {}),
  };
}

const row = async (id: string) =>
  (await db.select().from(automations).where(eq(automations.id, id)))[0]!;

describe("recordFire", () => {
  it("sends a story to triage once, and records later reports on it quietly", async () => {
    const thread = await insertThread();
    const watch = await insertWatch(thread.id);
    const other = await insertWatch(thread.id);
    const woke: string[] = [];
    const fire = async (automation: typeof watch, id: string, story?: string) => {
      const recorded = await recordFire({ automation, fire: fireOf(automation.id, id, story) });
      if (recorded === "triage") woke.push(id);
      return recorded;
    };

    expect(await fire(watch, "first-report", "story-a")).toBe("triage");
    const spoke = await row(watch.id);
    expect(await fire(watch, "second-report", "story-a")).toBe("quiet");
    // "Last spoke up" stays on the report that woke the thread.
    expect((await row(watch.id)).lastFiredAt).toEqual(spoke.lastFiredAt);
    await fire(watch, "another-story", "story-b");
    await fire(watch, "unthreaded");
    await fire(watch, "unthreaded-too");
    // Each watch hears a story once of its own.
    await fire(other, "same-story-elsewhere", "story-a");
    // A fire told twice (a redelivery, a replay) counts once.
    expect(await fire(watch, "first-report", "story-a")).toBe("ignored");

    expect(woke).toEqual([
      "first-report",
      "another-story",
      "unthreaded",
      "unthreaded-too",
      "same-story-elsewhere",
    ]);
    const recorded = await db.select().from(automationFires);
    expect(recorded).toHaveLength(6);
    expect(recorded.find((fire) => fire.eventId === "second-report")).toMatchObject({
      storylineId: "story-a",
      verdict: "quiet",
    });
    expect(recorded.find((fire) => fire.eventId === "first-report")).toMatchObject({
      verdict: null,
    });
    // The watch list shows only the fires past the hub.
    expect(await listFires({})).toHaveLength(5);
    // One triage for the thread, however many fires: they're judged together.
    expect(await triages()).toEqual([
      expect.objectContaining({ key: `triage:${thread.id}`, data: { threadId: thread.id } }),
    ]);
  });

  it("ends a one-shot watch on its fire, and hears nothing after", async () => {
    const watch = await insertWatch((await insertThread()).id, { repeat: null });
    const fire = (id: string) => recordFire({ automation: watch, fire: fireOf(watch.id, id) });

    expect(await fire("crossed")).toBe("triage");
    expect((await row(watch.id)).status).toBe("triggered");
    expect(await fire("crossed-again")).toBe("ignored");
    expect(await db.select().from(automationFires)).toHaveLength(1);
  });

  it("holds a repeating watch to its cooldown, and lets the next fire after it speak", async () => {
    const watch = await insertWatch((await insertThread()).id, { repeat: "1h" });
    const fire = (id: string) => recordFire({ automation: watch, fire: fireOf(watch.id, id) });

    expect(await fire("first")).toBe("triage");
    expect(await fire("ten-minutes-on")).toBe("quiet");
    await db
      .update(automations)
      .set({ lastFiredAt: new Date(Date.now() - 2 * 3_600_000) })
      .where(eq(automations.id, watch.id));
    expect(await fire("two-hours-on")).toBe("triage");
  });

  it("hears nothing for a watch paused, deleted or past its end", async () => {
    const thread = await insertThread();
    const paused = await insertWatch(thread.id, { status: "paused" });
    const deleted = await insertWatch(thread.id, { status: "deleted" });
    const ended = await insertWatch(thread.id, { expiresAt: new Date(Date.now() - 1) });
    for (const automation of [paused, deleted, ended]) {
      expect(await recordFire({ automation, fire: fireOf(automation.id, "late") })).toBe("ignored");
    }
  });

  it("records nothing when queueing its triage fails, so the fire is told again", async () => {
    const watch = await insertWatch((await insertThread()).id);
    const attempt = () => recordFire({ automation: watch, fire: fireOf(watch.id, "once") });

    vi.spyOn(triageKind, "enqueue").mockRejectedValueOnce(new Error("queue down"));
    await expect(attempt()).rejects.toThrow("queue down");
    expect(await db.select().from(automationFires)).toHaveLength(0);
    expect(await attempt()).toBe("triage");
  });
});

describe("a person's watches, bounded", () => {
  it("reach triage at most DAILY_AUTOMATION_WAKES times a day; the rest are recorded quietly", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const thread = await insertThread();
    const watches = [await insertWatch(thread.id), await insertWatch(thread.id)];
    let woke = 0;
    for (let at = 0; at < DAILY_AUTOMATION_WAKES + 3; at++) {
      const recorded = await recordFire({
        automation: watches[at % 2]!,
        fire: fireOf(watches[at % 2]!.id, `fire-${at}`),
      });
      if (recorded === "triage") woke += 1;
    }
    expect(woke).toBe(DAILY_AUTOMATION_WAKES);
    expect(await db.select().from(automationFires)).toHaveLength(DAILY_AUTOMATION_WAKES + 3);

    // A one-shot watch fires once, so it still speaks past the cap.
    const oneShot = await insertWatch(thread.id, { repeat: null });
    if (
      (await recordFire({ automation: oneShot, fire: fireOf(oneShot.id, "one-shot") })) === "triage"
    )
      woke += 1;
    expect(woke).toBe(DAILY_AUTOMATION_WAKES + 1);
  });

  it("tell a story first quieted by the cap once the day has passed, not hide it for good", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watch = await insertWatch((await insertThread()).id);
    const woke: string[] = [];
    const fire = async (id: string, story?: string) => {
      const recorded = await recordFire({ automation: watch, fire: fireOf(watch.id, id, story) });
      if (recorded === "triage") woke.push(id);
    };
    for (let at = 0; at < DAILY_AUTOMATION_WAKES; at++) await fire(`filler-${at}`);
    await fire("story-while-capped", "story-x");
    expect(woke).not.toContain("story-while-capped");

    await db.update(automationFires).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) });
    await fire("story-next-day", "story-x");
    expect(woke).toContain("story-next-day");
  });

  it("count fires that land together one at a time, so none slip past the cap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const watch = await insertWatch((await insertThread()).id);
    let woke = 0;
    const fire = async (id: string) => {
      const recorded = await recordFire({ automation: watch, fire: fireOf(watch.id, id) });
      if (recorded === "triage") woke += 1;
    };
    for (let at = 0; at < DAILY_AUTOMATION_WAKES - 4; at++) await fire(`before-${at}`);
    await Promise.all(Array.from({ length: 10 }, (_, at) => fire(`together-${at}`)));
    expect(woke).toBe(DAILY_AUTOMATION_WAKES);
  });

  it("stop at LIVE_AUTOMATIONS kept; deleted ones don't count", async () => {
    const thread = await insertThread();
    const watches = [];
    for (let at = 0; at < LIVE_AUTOMATIONS; at++) watches.push(await insertWatch(thread.id));
    const another = () =>
      createAutomation({
        threadId: thread.id,
        specialistId: null,
        source: "fake",
        thesis: false,
        condition: { about: "BTC" },
        description: "One more",
        note: "Testing the cap.",
        repeat: null,
        expiresAt: null,
      });
    await expect(another()).rejects.toThrow(`keep ${LIVE_AUTOMATIONS} watches`);
    expect(await db.select().from(automations)).toHaveLength(LIVE_AUTOMATIONS);

    await db
      .update(automations)
      .set({ status: "deleted" })
      .where(eq(automations.id, watches[0]!.id));
    expect(await another()).toMatchObject({ status: "active", description: "One more" });
  });
});

describe("a source's fires", () => {
  it("go to the watch's thread's triage, and never count for another source's watch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const thread = await insertThread();
    const mine = await insertWatch(thread.id);
    const pricesWatch = await insertWatch(thread.id, { source: "prices" });

    expect(
      await recordSourceFires("fake", [
        fireOf(mine.id, "mine"),
        fireOf(pricesWatch.id, "not-mine"),
        fireOf("not-a-uuid", "nonsense"),
      ]),
    ).toEqual(["triage", "ignored", "ignored"]);
    expect(await triages()).toEqual([
      expect.objectContaining({ key: `triage:${thread.id}`, data: { threadId: thread.id } }),
    ]);
    expect(await queued("turn")).toEqual([]);
  });

  it("from a run are recorded before the cursor after them is saved, and the next run starts there", async () => {
    const watch = await insertWatch((await insertThread()).id);
    await insertWatch((await insertThread()).id, { status: "paused" });
    fake.batches = [
      { fires: [fireOf(watch.id, "tick-1")], cursor: "after-1" },
      { fires: [], cursor: "after-2" },
    ];
    fake.runs = [];

    await runSource("fake", new AbortController().signal);
    expect(fake.runs[0]).toMatchObject({ cursor: null, since: null });
    expect(fake.runs[0]!.watches().map(({ id }) => id)).toEqual([watch.id]);
    expect(await loadCursor("fake")).toMatchObject({ cursor: "after-2" });

    // Started again, it replays the fire it already told: recorded once, cursor where it got to.
    fake.batches = [{ fires: [fireOf(watch.id, "tick-1")], cursor: "after-3" }];
    await runSource("fake", new AbortController().signal);
    expect(fake.runs[1]).toMatchObject({ cursor: "after-2", since: expect.any(Date) });
    expect(await db.select().from(automationFires)).toHaveLength(1);
    expect(await triages()).toHaveLength(1);
  });

  it("from a run see a watch set up or changed meanwhile at once, not at the next look", async () => {
    const thread = await insertThread();
    fake.batches = [{ fires: [], cursor: "after-1" }];
    let added = "";
    fake.after = async (context) => {
      expect(context.watches()).toEqual([]);
      const row = await createAutomation({
        threadId: thread.id,
        specialistId: null,
        source: "fake",
        thesis: false,
        condition: { about: "ETH" },
        description: "News on ETH",
        note: "They hold ETH.",
        repeat: null,
        expiresAt: null,
      });
      added = row.id;
      await vi.waitFor(() => expect(context.watches().map(({ id }) => id)).toEqual([row.id]));
      // And a source that hears of a watch it doesn't hold yet can read them all again now.
      expect((await context.refresh()).map(({ id }) => id)).toEqual([row.id]);
    };
    try {
      // Its regular look is an hour away, so only the change can have shown it.
      await runSource("fake", new AbortController().signal, 3_600_000);
    } finally {
      fake.after = null;
    }
    expect(added).not.toBe("");
  });

  it("from a run whose recording fails leave the cursor where it was", async () => {
    const watch = await insertWatch((await insertThread()).id);
    vi.spyOn(triageKind, "enqueue").mockRejectedValueOnce(new Error("queue down"));
    fake.batches = [{ fires: [fireOf(watch.id, "tick-1")], cursor: "after-1" }];

    await expect(runSource("fake", new AbortController().signal)).rejects.toThrow("queue down");
    expect(await loadCursor("fake")).toBeUndefined();
  });
});

describe("runSources", () => {
  it("keeps each set-up source with a run running until the job's signal aborts", async () => {
    const watch = await insertWatch((await insertThread()).id);
    fake.batches = [{ fires: [fireOf(watch.id, "tick-1")], cursor: "after-1" }];
    fake.runs = [];
    const stop = new AbortController();
    fake.after = async () => {
      // The run's fire is recorded and its cursor saved before the job is stopped.
      await vi.waitFor(async () => expect(await loadCursor("fake")).toBeDefined());
      stop.abort();
    };
    try {
      await runSources(stop.signal);
    } finally {
      fake.after = null;
    }
    expect(fake.runs).toHaveLength(1);
    expect(await loadCursor("fake")).toMatchObject({ cursor: "after-1" });
    expect(await triages()).toHaveLength(1);
  });
});
