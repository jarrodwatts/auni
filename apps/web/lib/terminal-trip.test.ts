import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { endTerminalTrip, noteTerminalTrip } from "./terminal-trip";

/** A browser's localStorage, as much of it as a trip uses. */
function storage(): Storage {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storage());
  vi.useFakeTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a trip to the terminal", () => {
  it("ends once, on the page the owner was sent from", () => {
    noteTerminalTrip("/app/s/nvidia");
    expect(endTerminalTrip()).toBe("/app/s/nvidia");
    expect(endTerminalTrip()).toBeNull();
  });

  it("is forgotten once its pairing link would have stopped working", () => {
    noteTerminalTrip("/app/chat/1");
    vi.advanceTimersByTime(21 * 60_000);
    expect(endTerminalTrip()).toBeNull();
  });

  it("starts only from the app's own pages", () => {
    noteTerminalTrip("/not-the-app");
    expect(endTerminalTrip()).toBeNull();
  });

  it("goes without when the browser blocks storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    noteTerminalTrip("/app/chat/1");
    expect(endTerminalTrip()).toBeNull();
  });
});
