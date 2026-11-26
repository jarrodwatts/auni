import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import { markDepositWait } from "@/lib/data/portfolio";

import { depositMarkQuery } from "./use-portfolio";

vi.mock(import("@/lib/data/portfolio"), async (original) => ({
  ...(await original()),
  markDepositWait: vi.fn(),
}));

afterEach(() => vi.useRealTimers());

// The mark took the app's one retry, so two failures (core restarting during an update) left
// Add money unable ever to watch (review of 2026-11-25).
it("asks for the watch's start mark again, further apart each time, until it comes", async () => {
  vi.useFakeTimers();
  const mark = "2026-11-25T09:00:00.000Z";
  vi.mocked(markDepositWait)
    .mockRejectedValueOnce(new Error("core is restarting"))
    .mockRejectedValueOnce(new Error("core is restarting"))
    .mockRejectedValueOnce(new Error("core is restarting"))
    .mockRejectedValueOnce(new Error("core is restarting"))
    .mockResolvedValue(mark);
  // The app's own defaults, which one more try rides out a blip with.
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  const observer = new QueryObserver(client, depositMarkQuery(1));
  const stop = observer.subscribe(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(markDepositWait).toHaveBeenCalledTimes(1);
    // Asked again 1s, then 2s, 4s and 8s later, so a core that's down is asked a few times a
    // minute, and not one ask is the last.
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 - 1);
    expect(markDepositWait).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(markDepositWait).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(markDepositWait).toHaveBeenCalledTimes(5);
    expect(observer.getCurrentResult().data).toBe(mark);
  } finally {
    stop();
  }
});
