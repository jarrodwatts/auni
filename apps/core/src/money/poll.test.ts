import { afterEach, describe, expect, it, vi } from "vitest";

import { poll } from "./poll.ts";

afterEach(() => vi.useRealTimers());

describe("poll", () => {
  it("asks until an answer comes, waiting the interval after each miss", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => (check.mock.calls.length === 3 ? "found" : undefined));
    const answer = poll(check, { every: 2_000, tries: 5 });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBe("found");
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("gives undefined once every try has waited out", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => undefined);
    let done = false;
    const answer = poll(check, { every: 1_000, tries: 3 }).finally(() => (done = true));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("stops at a throw from the check", async () => {
    const check = vi.fn(async () => {
      throw new Error("failed on chain");
    });
    await expect(poll(check, { every: 1_000, tries: 3 })).rejects.toThrow("failed on chain");
    expect(check).toHaveBeenCalledOnce();
  });
});
