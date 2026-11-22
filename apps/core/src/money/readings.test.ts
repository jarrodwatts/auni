import { describe, expect, it, vi } from "vitest";

import { reportGaps } from "./readings.ts";

describe("reportGaps", () => {
  it("reports each holding's gap with its numbers, once a day", () => {
    vi.useFakeTimers({ now: new Date("2026-10-15T00:00:00Z") });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const strk = { key: "hyperliquid:strk", held: 0n, recorded: 193_100_000_000_000_000_000n };
      const eth = { key: "hyperliquid:eth", held: 0n, recorded: 1_000_000_000_000_000_000n };
      reportGaps([strk]);
      reportGaps([strk]);
      reportGaps([eth]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "Specialists' records hold more hyperliquid:strk than the portfolio holds: " +
          "193.1 recorded, 0 held",
      );
      vi.advanceTimersByTime(24 * 60 * 60_000);
      reportGaps([strk]);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});
