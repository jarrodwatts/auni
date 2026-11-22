import { setTimeout as sleep } from "node:timers/promises";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { automationTools } from "../../automations/tools.ts";
import { runSource } from "../../automations/sources.ts";
import { db } from "../../db/client.ts";
import { automationFires, automations, jobs, sourceCursors, threads } from "../../db/schema.ts";
import { insertThread, setOwner, wipe } from "../../test/db.ts";
import { queued } from "../../test/jobs.ts";
import { DAILY_AUTOMATION_WAKES, recordFire } from "../../automations/automations.ts";
import { triageThread } from "../../automations/triage.ts";

// Triage's model, stood in: it answers whatever verdict the test sets, for every fire it is asked.
const triageModel = vi.hoisted(() => ({ verdict: "note", asked: 0 }));
vi.mock("../../agent/brain.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent/brain.ts")>()),
  askFast: async (turn: { prompt: readonly string[] }) => {
    triageModel.asked += 1;
    const ids = [...turn.prompt.join("\n").matchAll(/^fire (\S+):/gmu)].map(([, id]) => id);
    return {
      output: {
        verdicts: ids.map((fire) => ({ fire, verdict: triageModel.verdict, reason: "Stood in." })),
      },
    };
  },
}));
vi.mock("../../conversation/context.ts", () => ({ promptPortfolio: async () => null }));

// The clock through the hub, on a real database: its watches set up with the watch tool, its
// run started and stopped as Auni starts and stops, and each time recorded as a fire for triage.
// Only `Date` is stood in for; the run's own pause of a second between passes is real.

// The owner is in Sydney (+11 in November). Friday 20 November 2026, 5pm there is 06:00 UTC.
const FRIDAY_5PM = Date.parse("2026-11-20T06:00:00Z");
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

beforeEach(async () => {
  await wipe(threads, automations, automationFires, sourceCursors, jobs);
  await setOwner({ timeZone: "Australia/Sydney", brief: { every: "day", at: "08:00" } });
  triageModel.asked = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Auni running for a few of the clock's passes at `now`, then stopped. */
async function runFor(now: number, ms = 2_500): Promise<void> {
  vi.setSystemTime(now);
  const stop = new AbortController();
  const running = runSource("clock", stop.signal);
  await sleep(ms);
  stop.abort();
  await running;
}

/** Every fire recorded, by when its time was, then its watch's description. */
async function fires() {
  const rows = await db
    .select({
      watch: automations.description,
      late: automationFires.late,
      at: automationFires.happenedAt,
    })
    .from(automationFires)
    .innerJoin(automations, eq(automations.id, automationFires.automationId));
  return rows.toSorted((a, b) => a.at.getTime() - b.at.getTime() || a.watch.localeCompare(b.watch));
}

describe("the clock source", () => {
  it("fires each time once, keeps a schedule going, tells a missed time late, and survives restarts", async () => {
    // Set up on Monday, through the watch tool, as the agent sets one up.
    vi.setSystemTime(FRIDAY_5PM - 4 * 24 * HOUR);
    const thread = await insertThread();
    const [watch] = automationTools({ threadId: thread.id });
    const set = async (description: string, condition: Record<string, unknown>) => {
      const answer = (await watch!.handler({
        action: "create",
        source: "clock",
        condition,
        description,
        note: "They asked for this.",
      } as never)) as CallToolResult;
      expect(answer.isError, JSON.stringify(answer.content)).toBeUndefined();
    };
    await set("Every Friday at 5:00 pm", { every: ["fri"], at: "17:00" });
    await set("Once, on Friday at 5:00 pm", { at: "2026-11-20 17:00" });
    await set("Every Friday at 4:00 pm", { every: ["fri"], at: "16:00" });
    await set("Every day at 3:00 am", { every: "day", at: "03:00" });
    // The rows say when they were set up by the database's clock; this test's is Monday.
    await db.update(automations).set({ createdAt: new Date(FRIDAY_5PM - 4 * 24 * HOUR) });

    // A schedule keeps firing without being asked to repeat; a moment fires once.
    const rows = await db.select().from(automations);
    expect(rows.map(({ description, repeat }) => [description, repeat]).toSorted()).toEqual([
      ["Every Friday at 4:00 pm", "0"],
      ["Every Friday at 5:00 pm", "0"],
      ["Every day at 3:00 am", "0"],
      ["Once, on Friday at 5:00 pm", null],
    ]);

    // Auni was off all week and starts on Friday at 4:59:58pm: 4pm is an hour gone and told,
    // late; 3am, 14 hours gone, and the days before it, aren't.
    await runFor(FRIDAY_5PM - 2_000, 1_000);
    expect(await fires()).toEqual([
      { watch: "Every Friday at 4:00 pm", late: true, at: new Date(FRIDAY_5PM - HOUR) },
    ]);

    // Stopped, and started again at 5:00:01pm: the two 5pm watches fire on time, once each.
    await runFor(FRIDAY_5PM + 1_000);
    const atFive = [
      { watch: "Every Friday at 5:00 pm", late: false, at: new Date(FRIDAY_5PM) },
      { watch: "Once, on Friday at 5:00 pm", late: false, at: new Date(FRIDAY_5PM) },
    ];
    expect((await fires()).slice(1)).toEqual(atFive);
    // Each went to triage for its thread, which judges whether it wakes the chat.
    expect(await queued("triage")).toHaveLength(1);

    // Started again a little later, with nothing new due: nothing is told twice.
    await runFor(FRIDAY_5PM + 5_000);
    expect(await fires()).toHaveLength(3);
    const status = async () =>
      Object.fromEntries(
        (await db.select().from(automations)).map(({ description, status }) => [
          description,
          status,
        ]),
      );
    expect(await status()).toMatchObject({
      "Every Friday at 5:00 pm": "active",
      "Once, on Friday at 5:00 pm": "triggered",
    });

    // A week on, while running: the schedule fires again, the one-time watch doesn't.
    await runFor(FRIDAY_5PM + WEEK + 1_000);
    expect((await fires()).slice(3)).toEqual([
      { watch: "Every Friday at 4:00 pm", late: true, at: new Date(FRIDAY_5PM + WEEK - HOUR) },
      { watch: "Every Friday at 5:00 pm", late: false, at: new Date(FRIDAY_5PM + WEEK) },
    ]);
  }, 30_000);

  it("refuses a moment already past, saying the owner's time now", async () => {
    vi.setSystemTime(FRIDAY_5PM);
    const thread = await insertThread();
    const [watch] = automationTools({ threadId: thread.id });
    const answer = (await watch!.handler({
      action: "create",
      source: "clock",
      condition: { at: "2026-11-20 16:59" },
      description: "Once, at 4:59 pm",
      note: "Too late.",
    } as never)) as CallToolResult;
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer.content)).toContain(
      "That moment has passed: it is Friday 20 November 2026, 5:00 pm on the owner's clock (Australia/Sydney).",
    );
  });

  // Found in real use on 2026-11-14: "Remind me in 2 minutes to look at Nvidia's price" at 2:36 am
  // fired on time at 2:38, and nothing reached the chat. A time asked for is a promise, at any hour.
  for (const verdict of ["wake", "brief", "note"])
    it(`wakes the chat it was set in at 2:38 am, with a brief at 8, though triage would say ${verdict}`, async () => {
      triageModel.verdict = verdict;
      const twoThirtySix = Date.parse("2026-11-13T15:36:15Z");
      vi.setSystemTime(twoThirtySix);
      const thread = await insertThread();
      const [watch] = automationTools({ threadId: thread.id });
      await watch!.handler({
        action: "create",
        source: "clock",
        condition: { at: "2026-11-14 02:38" },
        description: "At 2:38 am today: remind me to look at Nvidia's price",
        note: "The owner asked to be reminded to look at Nvidia's price.",
      } as never);
      await db.update(automations).set({ createdAt: new Date(twoThirtySix) });

      await runFor(Date.parse("2026-11-13T15:38:00.175Z"));
      const [fired] = await db.select().from(automationFires);
      expect(fired).toMatchObject({ late: false });
      await triageThread(thread.id);

      const turns = await queued("turn");
      expect(turns).toHaveLength(1);
      expect(JSON.stringify(turns[0])).toContain("remind me to look at Nvidia's price");
      // It is not the model's to judge.
      expect(triageModel.asked).toBe(0);
      const [judged] = await db.select().from(automationFires);
      expect(judged!.verdict).toBe("wake");
    }, 30_000);

  it("keeps a time asked for when the day's other fires have used up the cap", async () => {
    const thread = await insertThread();
    const [busy, friday] = await db
      .insert(automations)
      .values([
        {
          threadId: thread.id,
          source: "prices",
          condition: { market: "BTC", moves: "either", percent: 1, within: "5m" },
          description: "Bitcoin moves 1%",
          note: "Every wiggle.",
          repeat: "0",
        },
        {
          threadId: thread.id,
          source: "clock",
          condition: { every: ["fri"], at: "17:00" },
          description: "Every Friday at 5:00 pm",
          note: "They asked for the week's check.",
          repeat: "0",
        },
      ])
      .returning();
    await db.insert(automationFires).values(
      Array.from({ length: DAILY_AUTOMATION_WAKES }, (_, index) => ({
        automationId: busy!.id,
        eventId: `wiggle-${index}`,
        payload: {},
        happenedAt: new Date(),
        verdict: "note" as const,
      })),
    );
    const fire = (automation: typeof busy, id: string) =>
      recordFire({
        automation: automation!,
        fire: { watchId: automation!.id, id, at: new Date(), report: {} },
      });
    expect(await fire(busy, "one-more-wiggle")).toBe("quiet");
    expect(await fire(friday, "friday")).toBe("triage");
  });
});
