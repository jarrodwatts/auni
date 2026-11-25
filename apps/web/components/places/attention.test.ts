import { describe, expect, it } from "vitest";

import type { Thread } from "@/lib/data/views";

import { attentionOf, chatStatus, moneyProgress } from "./attention";

const thread = (fields: Partial<Thread>) =>
  ({ state: "done", asking: false, unread: false, moving: null, ...fields }) as Thread;

describe("attentionOf", () => {
  it("marks a thread waiting while a card or a question waits on the person", () => {
    expect(attentionOf(thread({ moneyLine: "Buy $250" }))).toBe("waiting");
    expect(attentionOf(thread({ asking: true }))).toBe("waiting");
    expect(attentionOf(thread({ unread: true }))).toBe("unread");
    expect(attentionOf(thread({}))).toBeNull();
  });

  it("keeps a card waiting while Auni is answering in its chat", () => {
    const held = thread({ state: "running", moneyLine: "Status unknown: Sell Yes" });
    expect(attentionOf(held)).toBe("waiting");
    expect(attentionOf(thread({ state: "running" }))).toBeNull();
  });
});

describe("moneyProgress", () => {
  it("keeps going while a leg has yet to settle, counting only the ones that went through", () => {
    expect(moneyProgress({ done: 1, failed: 1, total: 4 })).toEqual({
      done: 1,
      total: 4,
      status: "now",
    });
  });

  it("closes to done when every leg went through, and to failed when any didn't", () => {
    expect(moneyProgress({ done: 3, failed: 0, total: 3 })?.status).toBe("done");
    expect(moneyProgress({ done: 2, failed: 1, total: 3 })?.status).toBe("failed");
    expect(moneyProgress({ done: 0, failed: 2, total: 2 })?.status).toBe("failed");
  });

  it("is nothing when no money is moving", () => {
    expect(moneyProgress(null)).toBeNull();
  });
});

describe("chatStatus", () => {
  it("shimmers while Auni works, and rings nothing then", () => {
    expect(chatStatus(thread({ state: "running" }))).toEqual({
      working: true,
      unread: false,
      money: null,
    });
  });

  it("rings the money while it moves, and while Auni works on what it did", () => {
    const moving = { done: 1, failed: 0, total: 2 };
    expect(chatStatus(thread({ moving })).money).toEqual({ done: 1, total: 2, status: "now" });
    expect(chatStatus(thread({ state: "running", moving })).working).toBe(true);
    expect(chatStatus(thread({ state: "running", moving })).money?.status).toBe("now");
  });

  it("keeps a landed ring beside an unread reply, as both wait to be read", () => {
    const status = chatStatus(thread({ unread: true, moving: { done: 2, failed: 0, total: 2 } }));
    expect(status.unread).toBe(true);
    expect(status.money?.status).toBe("done");
  });
});
