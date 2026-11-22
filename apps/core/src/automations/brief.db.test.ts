import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { conversationTools } from "../conversation/tools.ts";
import { db } from "../db/client.ts";
import { automationFires, automations, jobs, messages, owner, threads } from "../db/schema.ts";
import { insertThread, setOwner, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { markBriefed, runBrief } from "./brief.ts";

beforeEach(() => wipe(threads, messages, automations, automationFires, jobs));

// 08:30 on Saturday 7 November in Sydney, and 08:30 the day after.
const MORNING = new Date("2026-11-06T21:30:00Z");
const NEXT_MORNING = new Date("2026-11-07T21:30:00Z");

/** An owner in Sydney who has talked to Auni in a chat, and was briefed the morning before. */
async function sydneyOwner(
  fields: Partial<typeof owner.$inferInsert> = {},
  spoke = new Date(MORNING.getTime() - 2 * 86_400_000),
) {
  await setOwner({
    timeZone: "Australia/Sydney",
    lastBriefAt: new Date(MORNING.getTime() - 86_400_000),
    ...fields,
  });
  const chat = await insertThread({ title: "ETH plans" });
  await db
    .insert(messages)
    .values({
      threadId: chat.id,
      role: "user",
      parts: [{ type: "text", text: "Hi" }],
      createdAt: spoke,
    });
  return { chat };
}

async function fireOn(
  threadId: string,
  eventId: string,
  fields: Partial<typeof automationFires.$inferInsert>,
) {
  const [watch] = await db
    .insert(automations)
    .values({
      threadId,
      source: "prices",
      condition: {},
      description: `Watch for ${eventId}`,
      note: "They care.",
    })
    .returning();
  const [fire] = await db
    .insert(automationFires)
    .values({
      automationId: watch!.id,
      eventId,
      payload: { said: eventId },
      happenedAt: new Date("2026-11-06T15:00:00Z"),
      ...fields,
    })
    .returning();
  return fire!;
}

const fire = async (id: string) =>
  (await db.select().from(automationFires).where(eq(automationFires.id, id)))[0]!;

describe("the daily brief", () => {
  it("wakes the main conversation once a local day, with what triage held for it", async () => {
    const { chat } = await sydneyOwner();
    const held = await fireOn(chat.id, "hype-listing", {
      verdict: "brief",
      reason: "A minor listing; it can wait.",
    });
    const noted = await fireOn(chat.id, "eth-wick", { verdict: "note", reason: "Noise." });

    // Two runs at once, and one later that morning: one brief.
    await Promise.all([runBrief(MORNING), runBrief(MORNING)]);
    await runBrief(new Date(MORNING.getTime() + 3_600_000));

    const [brief, ...more] = await queued("turn");
    expect(more).toEqual([]);
    expect(brief).toMatchObject({ data: { threadId: chat.id } });
    const reason = brief!.data.reason as string;
    expect(reason).toContain("time for their brief");
    expect(reason).toContain('<held_item>{"watch":"Watch for hype-listing"');
    expect(reason).toContain("A minor listing; it can wait.");
    expect(reason).not.toContain("eth-wick");
    // Told only once the brief's answer is kept (conversation/turn.ts).
    expect(brief!.data.briefed).toEqual([held.id]);
    expect((await fire(held.id)).briefedAt).toBeNull();
    await db.transaction((tx) => markBriefed(tx, brief!.data.briefed as string[]));
    expect((await fire(held.id)).briefedAt).toBeInstanceOf(Date);
    expect((await fire(noted.id)).briefedAt).toBeNull();

    // The next morning's brief doesn't tell the same item again.
    await runBrief(NEXT_MORNING);
    const turns = await queued("turn");
    expect(turns).toHaveLength(2);
    expect(turns[1]!.data.reason).toContain("Your watches held nothing for it.");
    expect(turns[1]!.data.briefed).toBeUndefined();
  });

  it("tells again next morning what a brief that never got written held", async () => {
    const { chat } = await sydneyOwner();
    await fireOn(chat.id, "hype-listing", { verdict: "brief", reason: "It can wait." });
    await runBrief(MORNING);
    await runBrief(NEXT_MORNING);
    const turns = await queued("turn");
    expect(turns.map(({ data }) => data.reason)).toEqual([
      expect.stringContaining("It can wait."),
      expect.stringContaining("It can wait."),
    ]);
  });

  // A first brief minutes after they first spoke, at whatever hour that was, would only
  // interrupt them; a time after they spoke is one they were promised.
  it("counts the owner's first brief from when they first spoke", async () => {
    const spoke = new Date(MORNING.getTime() + 9 * 3_600_000); // 17:30 on their first day
    await sydneyOwner({ lastBriefAt: null }, spoke);
    await runBrief(new Date(spoke.getTime() + 60_000));
    expect(await queued("turn")).toEqual([]);
    expect((await db.select().from(owner))[0]!.lastBriefAt).toBeNull();
    await runBrief(NEXT_MORNING);
    expect(await queued("turn")).toHaveLength(1);
  });

  it("writes a new owner's first brief at a time they set later on the day they began", async () => {
    const spoke = new Date(MORNING.getTime() + 3 * 3_600_000); // 11:30 on their first day
    await sydneyOwner({ lastBriefAt: null, brief: { every: "day", at: "11:40" } }, spoke);
    await runBrief(new Date(spoke.getTime() + 11 * 60_000));
    expect(await queued("turn")).toHaveLength(1);
  });

  // After a move west a local date comes round again: it must not be taken for one briefed.
  it("briefs again when a move west brings the same date round", async () => {
    const tokyoMorning = new Date("2026-11-05T23:00:00Z"); // 08:00 on the 6th in Tokyo
    await sydneyOwner({
      timeZone: "Asia/Tokyo",
      lastBriefAt: new Date(tokyoMorning.getTime() - 86_400_000),
    });
    await runBrief(tokyoMorning);
    await db.update(owner).set({ timeZone: "America/Los_Angeles" });
    await runBrief(new Date("2026-11-06T16:00:00Z")); // 08:00 on the 6th in Los Angeles
    expect(await queued("turn")).toHaveLength(2);
  });

  it("waits until the owner has said something to Auni", async () => {
    await setOwner({ timeZone: "Australia/Sydney" });
    await runBrief(MORNING);
    expect(await queued("turn")).toEqual([]);
    expect((await db.select().from(owner))[0]!.lastBriefAt).toBeNull();
  });

  // "Send my brief at 7am instead, and only on weekdays": the same brief, moved.
  it("moves to the schedule the owner asks for, still holding what triage keeps for it", async () => {
    const { chat } = await sydneyOwner();
    const [, setNotices] = conversationTools({ threadId: randomUUID() });
    const weekdays = { every: ["mon", "tue", "wed", "thu", "fri"], at: "07:00" };
    const moved = await setNotices!.handler({ brief: weekdays });
    expect(moved.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining("every weekday at 7:00 am") }),
    ]);
    const held = await fireOn(chat.id, "hype-listing", {
      verdict: "brief",
      reason: "It can wait.",
    });

    await runBrief(MORNING); // Saturday 08:30 there
    await runBrief(NEXT_MORNING); // Sunday
    expect(await queued("turn")).toEqual([]);
    expect(await fire(held.id)).toMatchObject({ verdict: "brief", briefedAt: null });
    await runBrief(new Date("2026-11-08T20:00:00Z")); // Monday 07:00 there
    const [brief] = await queued("turn");
    expect(brief!.data.briefed).toEqual([held.id]);
  });

  // Live, 2026-11-14: moved to 15:02 "so I can see what it looks like", it never came, and
  // set_notices said nothing of that. Both happen at 08:30 in Sydney here, after its brief.
  it("comes again at a time moved later that day, and says truly when the next one comes", async () => {
    const { chat } = await sydneyOwner({ lastBriefAt: new Date(MORNING.getTime() - 60_000) });
    vi.useFakeTimers({ now: MORNING, toFake: ["Date"] });
    try {
      const [, setNotices, showBrief] = conversationTools({
        threadId: randomUUID(),
      });
      const moved = await setNotices!.handler({ brief: { every: "day", at: "15:02" } });
      expect(moved.structuredContent).toMatchObject({ next_brief: "2026-11-07T04:02:00.000Z" });
      expect(moved.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining(
            "The next comes Saturday 7 November 2026, 3:02 pm, or within five minutes after.",
          ),
        }),
      ]);
      // A look at it now uses nothing up: the held item is still held, and nothing is claimed.
      const held = await fireOn(chat.id, "hype-listing", {
        verdict: "brief",
        reason: "It can wait.",
      });
      const look = await showBrief!.handler({});
      expect(look.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("It can wait.") }),
      ]);
      expect(await fire(held.id)).toMatchObject({ verdict: "brief", briefedAt: null });
      expect(await queued("turn")).toEqual([]);

      await runBrief(new Date("2026-11-07T04:01:00Z"));
      expect(await queued("turn")).toEqual([]);
      await runBrief(new Date("2026-11-07T04:05:00Z"));
      const [brief] = await queued("turn");
      expect(brief).toMatchObject({ data: { threadId: chat.id, briefed: [held.id] } });
      expect(brief!.data.reason).toContain("3:05 pm on the owner's clock");
    } finally {
      vi.useRealTimers();
    }
  });

  it("comes when the owner asks for it, and not at all once they turn it off", async () => {
    const { chat } = await sydneyOwner();
    const [, setNotices] = conversationTools({ threadId: randomUUID() });

    const moved = await setNotices!.handler({ brief: { every: "day", at: "09:15" } });
    expect(moved.structuredContent).toMatchObject({
      brief: { every: "day", at: "09:15" },
      time_zone: "Australia/Sydney",
    });
    await runBrief(MORNING); // 08:30 there: not yet
    expect(await queued("turn")).toEqual([]);
    await runBrief(new Date(MORNING.getTime() + 45 * 60_000)); // 09:15
    expect(await queued("turn")).toHaveLength(1);

    // What triage held for the brief goes back to triage, which now wakes or notes it.
    const held = await fireOn(chat.id, "hype-listing", {
      verdict: "brief",
      reason: "A minor listing; it can wait.",
    });
    await setNotices!.handler({ brief: null });
    expect(await fire(held.id)).toMatchObject({ verdict: null, reason: null });
    expect(await queued("triage")).toEqual([
      expect.objectContaining({ key: `triage:${chat.id}`, data: { threadId: chat.id } }),
    ]);
    await runBrief(NEXT_MORNING);
    expect(await queued("turn")).toHaveLength(1);

    const elsewhere = await setNotices!.handler({ time_zone: "Europe/London" });
    expect(elsewhere.structuredContent).toMatchObject({
      brief: null,
      time_zone: "Europe/London",
    });
    expect((await setNotices!.handler({ time_zone: "Mars/Olympus" })).isError).toBe(true);
  });
});
