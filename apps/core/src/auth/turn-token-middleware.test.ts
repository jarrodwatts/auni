import { afterEach, describe, expect, it, vi } from "vitest";

import { turnCallCounter } from "./turn-token-middleware.ts";

// read_chain's cap on the calls a turn makes.
const CALLS = 3;
const turnCallAllowed = turnCallCounter(CALLS, "calls");

describe("turnCallCounter", () => {
  it("cuts a turn off once it has made its calls, and starts the thread's next turn afresh", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const turn = { threadId: "a", turnStartedAt: "2026-10-01T00:00:00.000Z" };
    for (let call = 0; call < CALLS; call++) expect(turnCallAllowed(turn)).toBe(true);
    expect(turnCallAllowed(turn)).toBe(false);
    expect(turnCallAllowed({ ...turn, turnStartedAt: "2026-10-01T00:05:00.000Z" })).toBe(true);
  });

  it("counts each thread's turn on its own", () => {
    const started = "2026-10-01T00:00:00.000Z";
    for (let call = 0; call < CALLS; call++)
      turnCallAllowed({ threadId: "b", turnStartedAt: started });
    expect(turnCallAllowed({ threadId: "c", turnStartedAt: started })).toBe(true);
  });
});

describe("turnCallCounter, over time", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a live turn's count, and drops one only once its token can't still be in use", () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T00:00:00.000Z") });
    const turn = { threadId: "d", turnStartedAt: "2026-10-01T00:00:00.000Z" };
    for (let call = 0; call < CALLS; call++) turnCallAllowed(turn);
    const sweep = (threadId: string) =>
      turnCallAllowed({ threadId, turnStartedAt: new Date().toISOString() });

    vi.advanceTimersByTime(30 * 60_000);
    sweep("e");
    expect(turnCallAllowed(turn)).toBe(false);

    vi.advanceTimersByTime(61 * 60_000);
    sweep("f");
    expect(turnCallAllowed(turn)).toBe(true);
  });
});
