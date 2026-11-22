import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { keepRunning } from "./keep-running.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("starts a loop again 5s after it throws or ends, until aborted", async () => {
  const stop = new AbortController();
  let runs = 0;
  const done = keepRunning(
    "a loop",
    async () => {
      runs += 1;
      if (runs === 1) throw new Error("dropped");
    },
    stop.signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(runs).toBe(1);
  expect(console.error).toHaveBeenCalledWith("a loop stopped", expect.any(Error));
  await vi.advanceTimersByTimeAsync(4_999);
  expect(runs).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(runs).toBe(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(runs).toBe(3);
  stop.abort();
  await done;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(runs).toBe(3);
});

it("returns once aborted, without logging the loop's own abort", async () => {
  const stop = new AbortController();
  const done = keepRunning(
    "a loop",
    (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
    stop.signal,
  );
  stop.abort();
  await done;
  expect(console.error).not.toHaveBeenCalled();
});
