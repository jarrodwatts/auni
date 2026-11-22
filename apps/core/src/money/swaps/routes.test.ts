import { NETWORKS } from "@auni/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SwapRoute } from "../../apps/contract.ts";
import { filling } from "../../apps/registry.ts";
import type { EvmRoute } from "./evm.ts";
import { quoteStock, quoteSwap } from "./routes.ts";

// The routes alone stand in for the registry, so no app loads.
vi.mock(import("../../apps/registry.ts"), () => ({ filling: vi.fn() }) as never);

const request = {
  chain: "monad",
  sellToken: NETWORKS.monad.usdc,
  buyToken: "0x0000000000000000000000000000000000000a11",
  sellAmount: 25_000_000n,
  slippageBps: 100,
} as const;

const route = (provider: string, buyAmount: bigint): EvmRoute => ({
  provider,
  buyAmount,
  minBuyAmount: buyAmount,
});

const kyber = vi.fn<SwapRoute["quote"]>();
const kuru = vi.fn<SwapRoute["quote"]>();
const lifi = vi.fn<SwapRoute["quote"]>();

beforeEach(() => {
  vi.clearAllMocks();
  for (const venue of [kyber, kuru, lifi]) venue.mockRejectedValue(new Error("No quote."));
  vi.mocked(filling).mockReturnValue([
    { about: { id: "kyberswap", name: "KyberSwap" }, part: { trades: "any", quote: kyber } },
    { about: { id: "kuru", name: "Kuru" }, part: { trades: "stocks", quote: kuru } },
    { about: { id: "lifi", name: "LI.FI" }, part: { trades: "stocks", quote: lifi } },
  ] as never);
});
afterEach(() => vi.useRealTimers());

describe("quoteStock", () => {
  it("takes a venue's quote", async () => {
    const quoted = route("Kuru", 10n ** 17n);
    kuru.mockResolvedValue(quoted);
    await expect(quoteStock(request)).resolves.toBe(quoted);
  });

  it("takes the venue that pays the most", async () => {
    kyber.mockResolvedValue(route("KyberSwap", 9_950n));
    const best = route("LI.FI", 9_990n);
    lifi.mockResolvedValue(best);
    await expect(quoteStock(request)).resolves.toBe(best);
  });

  // The agent reads these to say why a trade moved to Solana.
  it("names each venue's reason when none can quote", async () => {
    kuru.mockRejectedValue(new Error("no book for this stock"));
    await expect(quoteStock(request)).rejects.toThrow(
      "KyberSwap: No quote; Kuru: no book for this stock; LI.FI: No quote.",
    );
  });

  it("gives up on a venue that doesn't answer, rather than hold the card", async () => {
    vi.useFakeTimers();
    kyber.mockReturnValue(new Promise(() => {}));
    const quoted = expect(quoteStock(request)).rejects.toThrow("KyberSwap: no answer within 10 s;");
    await vi.advanceTimersByTimeAsync(10_000);
    await quoted;
  });
});

describe("quoteSwap", () => {
  it("asks only the routes that trade any pair", async () => {
    const quoted = route("KyberSwap", 9_950n);
    kyber.mockResolvedValue(quoted);
    lifi.mockResolvedValue(route("LI.FI", 9_990n));
    await expect(quoteSwap(request)).resolves.toBe(quoted);
    expect(kuru).not.toHaveBeenCalled();
    expect(lifi).not.toHaveBeenCalled();
  });

  // No other venue could take it, so a slow answer is worth waiting for.
  it("waits on a route past the stock trade's limit", async () => {
    vi.useFakeTimers();
    const quoted = route("KyberSwap", 9_950n);
    kyber.mockReturnValue(
      new Promise((resolve) => {
        setTimeout(() => resolve(quoted), 12_000);
      }),
    );
    const answer = quoteSwap(request);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(answer).resolves.toBe(quoted);
  });
});
