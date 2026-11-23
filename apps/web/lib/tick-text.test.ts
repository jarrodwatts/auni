import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeSecondTick } from "./tick-text";

describe("subscribeSecondTick", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares one 1-second clock across listeners and stops when the last unsubscribes", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);

    const a = vi.fn();
    const b = vi.fn();
    const stopA = subscribeSecondTick(a);
    const stopB = subscribeSecondTick(b);

    vi.advanceTimersByTime(2_000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);

    stopA();
    vi.advanceTimersByTime(1_000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(3);

    stopB();
    vi.advanceTimersByTime(2_000);
    expect(b).toHaveBeenCalledTimes(3);
  });
});
