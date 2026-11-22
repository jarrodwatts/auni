import { describe, expect, it, vi } from "vitest";

vi.mock("./wallets.ts", async (original) => ({
  ...(await original<object>()),
  hasWallet: async () => false,
  walletAddresses: async () => ({ evm: null, solana: null }),
}));

const { sweepDue, sweepWhenDue } = await import("./sweep.ts");

describe("the sweep's turn", () => {
  // The page opens before the first take makes the wallet: that look found nothing to read,
  // and the wallet made next was left a quarter hour without its first look.
  it("isn't taken by a sweep with no wallet to read", async () => {
    await sweepWhenDue(false);
    expect(sweepDue(false)).toBe(true);
  });

  it("comes each quarter hour, or every ten seconds while a deposit is expected", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 24 * 60 * 60_000 });
    try {
      expect(sweepDue(false)).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(sweepDue(false)).toBe(false);
      expect(sweepDue(true)).toBe(true);
      vi.advanceTimersByTime(5_000);
      expect(sweepDue(true)).toBe(false);
      vi.advanceTimersByTime(15 * 60_000);
      expect(sweepDue(false)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
