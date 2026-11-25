import type { ThreadId } from "@auni/shared";
import { describe, expect, it } from "vitest";

import type { Thread } from "@/lib/data/views";

import { placesOf } from "./use-places";

let at = 0;
const thread = (title: string, fields: Partial<Thread> = {}): Thread =>
  ({
    id: title as ThreadId,
    title,
    state: "done",
    asking: false,
    unread: false,
    moving: null,
    archived: false,
    pinned: false,
    pinnedAt: null,
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, at++)).toISOString(),
    ...fields,
  }) as Thread;

const titles = (places: readonly { readonly thread: Thread }[]) =>
  places.map(({ thread }) => thread.title);
const take = (value: bigint) => ({ value, change: null });

describe("placesOf", () => {
  it("puts each chat in one place: waiting on the owner, holding positions, or the rest", () => {
    const threads = [
      thread("Buy $250 of Nvidia", { moneyLine: "Buy $250" }),
      thread("AI buildout", { holds: true }),
      thread("How am I doing?"),
      thread("Fed bet", { asking: true, holds: true }),
    ];
    const takes = new Map([
      ["AI buildout" as ThreadId, take(2_000_000n)],
      ["Fed bet" as ThreadId, take(500_000n)],
    ]);
    const places = placesOf(threads, takes);
    expect(titles(places.needsYou)).toEqual(["Fed bet", "Buy $250 of Nvidia"]);
    expect(titles(places.takes)).toEqual(["AI buildout"]);
    expect(titles(places.others)).toEqual(["How am I doing?"]);
    expect(places.waitingCount).toBe(2);
  });

  it("orders takes pinned first, then newest, never by what they're worth as prices tick", () => {
    const threads = [
      thread("Older", { holds: true }),
      thread("Newer", { holds: true }),
      thread("Pinned", { holds: true, pinned: true, pinnedAt: "2026-11-01T00:00:00Z" }),
    ];
    const order = (older: bigint, newer: bigint) =>
      titles(
        placesOf(
          threads,
          new Map([
            ["Older" as ThreadId, take(older)],
            ["Newer" as ThreadId, take(newer)],
          ]),
        ).takes,
      );
    expect(order(1_000n, 999n)).toEqual(["Pinned", "Newer", "Older"]);
    expect(order(998n, 999n)).toEqual(["Pinned", "Newer", "Older"]);
  });

  it("keeps a take in Your takes before its value is read", () => {
    const threads = [thread("AI buildout", { holds: true }), thread("Chat")];
    const before = placesOf(threads, new Map());
    expect(titles(before.takes)).toEqual(["AI buildout"]);
    expect(before.takes[0]?.take).toBeUndefined();
    expect(titles(before.others)).toEqual(["Chat"]);
  });

  // A closed take showed under Your takes on every load, until its own read moved it to Chats
  // (2026-11-25 council). The thread list says it holds nothing, so it starts in Chats.
  it("places a closed take in Chats on first paint, before any value is read", () => {
    const threads = [thread("Close my bitcoin long", { moveCount: 2, holds: false })];
    const places = placesOf(threads, new Map());
    expect(titles(places.takes)).toEqual([]);
    expect(titles(places.others)).toEqual(["Close my bitcoin long"]);
    expect(places.others[0]?.take).toBeNull();
  });

  // A take that sold everything sat in Your takes as a blank row for good, while Money dropped it.
  it("moves a take that holds nothing any more to Chats, as Money drops it", () => {
    const threads = [thread("Close my bitcoin long", { holds: true }), thread("Chat")];
    const closed = placesOf(threads, new Map([["Close my bitcoin long" as ThreadId, null]]));
    expect(titles(closed.takes)).toEqual([]);
    expect(titles(closed.others)).toEqual(["Chat", "Close my bitcoin long"]);
    expect(closed.others[1]?.take).toBeNull();
  });

  it("keeps a held order in Needs you while Auni answers in its chat", () => {
    const held = thread("Fed bet", { state: "running", moneyLine: "Status unknown: Sell Yes" });
    const places = placesOf([held, thread("Busy", { state: "running" })], new Map());
    expect(titles(places.needsYou)).toEqual(["Fed bet"]);
    expect(places.waitingCount).toBe(1);
  });

  it("leaves archived chats to search, unless something in one still waits", () => {
    const places = placesOf(
      [
        thread("Old", { archived: true }),
        thread("Old but waiting", { archived: true, moneyLine: "Sell Yes" }),
      ],
      new Map(),
    );
    expect(titles(places.archived)).toEqual(["Old"]);
    expect(titles(places.needsYou)).toEqual(["Old but waiting"]);
  });
});
