import { beforeEach, describe, expect, it, vi } from "vitest";

import { forgetStartIds, startIdsFor } from "./start-ids";

// A start whose answer never came may still have made its chat in core, which makes a chat once
// per id pair. So the same words sent again, even after a reload, must go under the same ids, or
// the owner gets a second chat with a second answer.

let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
});

describe("the ids a new chat starts under", () => {
  it("are kept for the same words until a start with them is answered", () => {
    const first = startIdsFor("AI power demand keeps climbing");
    // Both answers lost: the words are back in the box and sent again.
    expect(startIdsFor("AI power demand keeps climbing")).toEqual(first);
    forgetStartIds(first);
    expect(startIdsFor("AI power demand keeps climbing").threadId).not.toBe(first.threadId);
  });

  it("are kept through a reload, which keeps only this tab's storage", async () => {
    const first = startIdsFor("AI power demand keeps climbing");
    vi.resetModules();
    const reloaded = await import("./start-ids");
    expect(reloaded.startIdsFor("AI power demand keeps climbing")).toEqual(first);
  });

  it("are new for other words, which are a chat of their own", () => {
    const first = startIdsFor("AI power demand keeps climbing");
    const other = startIdsFor("Gold keeps climbing");
    expect(other.threadId).not.toBe(first.threadId);
    expect(other.messageId).not.toBe(first.messageId);
  });

  it("aren't dropped by an older start being answered", () => {
    const older = startIdsFor("AI power demand keeps climbing");
    const newer = startIdsFor("Gold keeps climbing");
    forgetStartIds(older);
    expect(startIdsFor("Gold keeps climbing")).toEqual(newer);
  });

  it("are still chosen when storage is blocked", () => {
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    });
    const ids = startIdsFor("AI power demand keeps climbing");
    expect(ids.threadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(() => forgetStartIds(ids)).not.toThrow();
  });
});
