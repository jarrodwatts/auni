import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SourceBatch, SourceWatch } from "../contract.ts";
import query from "./fixtures/auto-query.json";
import { sseFrames } from "./sse.ts";
import { elfaCooldown, elfaSource, firedEventMatch, leaseHours } from "./watch.ts";

afterEach(() => {
  process.env.ELFA_AUTO_API_KEY = "";
  vi.unstubAllGlobals();
});

describe("a news watch's fire", () => {
  // Elfa's notification is flat, with the trigger context beside the alert (docs.elfa.ai/auto/notifications).
  const match = {
    eventId: "e1a0fc65-39e6-44f8-80c8-e7223019bc96",
    title: "Hyperliquid Strategies adds about 5.1 million HYPE in 29 days",
    eventType: "marketFlow",
    implication: "bullish",
  };
  const payload = {
    status: "triggered",
    title: "Plan Triggered",
    body: "News on HYPE",
    trigger: {
      type: "events",
      matchedConditions: [
        { condition: { source: "price", args: { symbol: "HYPE" } }, match: { observedValue: 81 } },
        { condition: { source: "events", args: { entity: "HYPE" } }, match },
      ],
    },
  };

  it("finds the event an events condition matched", () => {
    expect(firedEventMatch(payload)).toBe(match);
    expect(firedEventMatch({ ...payload, trigger: { matchedConditions: [] } })).toBeNull();
    expect(firedEventMatch({ title: "Plan Triggered" })).toBeNull();
  });
});

describe("an Elfa lease", () => {
  const now = Date.parse("2026-11-06T00:00:00Z");
  it("is Elfa's shortest duration that covers the watch, and its longest for one with no end", () => {
    expect(leaseHours(null, now)).toBe(720);
    expect(leaseHours(new Date(now + 90 * 60_000), now)).toBe(2);
    expect(leaseHours(new Date(now + 24 * 3_600_000), now)).toBe(24);
    expect(leaseHours(new Date(now + 60 * 24 * 3_600_000), now)).toBe(720);
  });

  it("asks Elfa for the longest cooldown no longer than the watch's, and Auni holds to the rest", () => {
    expect(elfaCooldown(0)).toBe("0");
    expect(elfaCooldown(90 * 60_000)).toBe("1h");
    expect(elfaCooldown(3 * 86_400_000)).toBe("24h");
    expect(elfaCooldown(30 * 86_400_000)).toBe("7d");
  });
});

describe("Elfa's stream", () => {
  const ref = "a12d20ff-6cb2-433e-afed-cc2e6a0380b6";
  const stream = readFileSync(new URL("./fixtures/auto-stream.txt", import.meta.url), "utf8");

  /** The fixture's bytes in uneven chunks, as a network hands them over. */
  function chunked(text: string): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 37) controller.enqueue(bytes.slice(at, at + 37));
        controller.close();
      },
    });
  }

  it("reads frames split anywhere, skipping keep-alives", async () => {
    const frames = [];
    for await (const frame of sseFrames(chunked(stream))) frames.push(frame);
    expect(frames.map(({ event }) => event)).toEqual([
      "notification",
      "notification",
      "notification",
      "end",
    ]);
    expect(frames[0]!.id).toBe("6f1c1a52-0f0e-4a77-9b52-2f6f3a0c9a10");
  });

  /** Elfa's stream as recorded, each query answering as the fixture: the batches a run yields. */
  async function heard(input: {
    readonly watches: readonly SourceWatch[];
    readonly stored?: readonly SourceWatch[];
    readonly since: Date | null;
  }): Promise<SourceBatch[]> {
    process.env.ELFA_AUTO_API_KEY = "elfa-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/v2/auto/queries/stream")
          ? new Response(chunked(stream), { headers: { "content-type": "text/event-stream" } })
          : Response.json(query),
      ),
    );
    const batches: SourceBatch[] = [];
    for await (const batch of elfaSource.run({
      watches: () => input.watches,
      refresh: async () => input.stored ?? input.watches,
      cursor: null,
      since: input.since,
      signal: new AbortController().signal,
    }))
      batches.push(batch);
    return batches;
  }

  it("catches up on each watch's fires since Auni last heard, then hears its own as they come", async () => {
    const watch = { id: "watch-1", condition: {}, ref, since: new Date("2026-03-01T00:00:00Z") };
    const batches = await heard({ watches: [watch], since: new Date("2026-04-01T00:00:00Z") });

    const fires = batches.flatMap((batch) => batch.fires);
    // The one fire since then, read from its query and marked late; the stream's own fire next;
    // another query on the key, and a status update, are left alone.
    expect(fires.map(({ id, late }) => ({ id, late }))).toEqual([
      { id: "7d0f2b8e-1c3a-4e5f-9a7b-1b2c3d4e5f60", late: true },
      { id: "2dbf0d70-a85f-4f67-9bd3-876e8fd89f86", late: undefined },
    ]);
    expect(fires.every(({ watchId }) => watchId === "watch-1")).toBe(true);
    expect(fires[1]!.report).toMatchObject({ alert: "Plan Triggered: BTC below 100k" });
  });

  it("catches a watch up from when it was set up, the first time it opens", async () => {
    // An earlier run found no query active and ended without saving where it got to.
    const watch = { id: "watch-1", condition: {}, ref, since: new Date("2026-03-31T00:00:00Z") };
    const fires = (await heard({ watches: [watch], since: null })).flatMap(({ fires }) => fires);
    expect(fires.map(({ id, late }) => ({ id, late }))).toEqual([
      { id: "7d0f2b8e-1c3a-4e5f-9a7b-1b2c3d4e5f60", late: true },
      { id: "2dbf0d70-a85f-4f67-9bd3-876e8fd89f86", late: undefined },
    ]);
  });

  it("hears a watch set up a moment ago, before the list it keeps holds it", async () => {
    const watch = { id: "watch-1", condition: {}, ref, since: new Date("2026-03-31T00:00:00Z") };
    const batches = await heard({ watches: [], stored: [watch], since: new Date() });
    // Its own fire as the stream told it, and what it fired before, caught up from its query.
    expect(batches.flatMap(({ fires }) => fires).map(({ id, late }) => ({ id, late }))).toEqual([
      { id: "2dbf0d70-a85f-4f67-9bd3-876e8fd89f86", late: undefined },
      { id: "7d0f2b8e-1c3a-4e5f-9a7b-1b2c3d4e5f60", late: true },
    ]);
    // Someone else's query on the key, and the status update, never move the cursor.
    expect(batches).toHaveLength(2);
  });
});
