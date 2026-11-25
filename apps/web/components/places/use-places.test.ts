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
      thread("Buy $250 of Nvidia", { state: "needs_user" }),
      thread("AI buildout"),
      thread("How am I doing?"),
      thread("Fed bet", { asking: true }),
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

  it("orders takes pinned first, then by what they hold", () => {
    const threads = [
      thread("Small"),
      thread("Big"),
      thread("Pinned", { pinned: true, pinnedAt: "2026-11-01T00:00:00Z" }),
    ];
    const takes = new Map([
      ["Small" as ThreadId, take(1n)],
      ["Big" as ThreadId, take(9n)],
      ["Pinned" as ThreadId, take(5n)],
    ]);
    expect(titles(placesOf(threads, takes).takes)).toEqual(["Pinned", "Big", "Small"]);
  });

  it("keeps a chat Auni is still answering out of Needs you until it's the owner's turn", () => {
    const places = placesOf([thread("Busy", { state: "running", asking: true })], new Map());
    expect(places.needsYou).toEqual([]);
  });

  it("leaves archived chats to search, unless something in one still waits", () => {
    const places = placesOf(
      [
        thread("Old", { archived: true }),
        thread("Old but waiting", { archived: true, state: "needs_user" }),
      ],
      new Map(),
    );
    expect(titles(places.archived)).toEqual(["Old"]);
    expect(titles(places.needsYou)).toEqual(["Old but waiting"]);
  });
});
