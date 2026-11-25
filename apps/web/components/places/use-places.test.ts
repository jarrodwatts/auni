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
      thread("AI buildout", { moveCount: 2 }),
      thread("How am I doing?"),
      thread("Fed bet", { asking: true, moveCount: 1 }),
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
      thread("Older", { moveCount: 1 }),
      thread("Newer", { moveCount: 1 }),
      thread("Pinned", { moveCount: 1, pinned: true, pinnedAt: "2026-11-01T00:00:00Z" }),
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

  it("keeps a take in Your takes before its value is read, and once it holds nothing priced", () => {
    const threads = [thread("AI buildout", { moveCount: 2 }), thread("Chat")];
    const before = placesOf(threads, new Map());
    expect(titles(before.takes)).toEqual(["AI buildout"]);
    expect(before.takes[0]?.take).toBeUndefined();
    const read = placesOf(threads, new Map([["AI buildout" as ThreadId, null]]));
    expect(titles(read.takes)).toEqual(["AI buildout"]);
    expect(titles(read.others)).toEqual(["Chat"]);
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
