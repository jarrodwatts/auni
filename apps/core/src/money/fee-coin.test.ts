import { NETWORKS } from "@auni/shared";
import { describe, expect, it, vi } from "vitest";

import { prepareLeg } from "./actions.ts";
import { whereFeesArePaid } from "./fee-coin.ts";
import { ownGas } from "./gas.ts";
import type { Holding } from "./portfolio.ts";
import { NoFeeCoin, type Recipe } from "./recipe.ts";

const held = (chain: string, instrument: string, quantity: string): Holding => ({
  venue: "wallet",
  chain,
  instrument,
  symbol: instrument === "native" ? "COIN" : "USDC",
  quantity,
  decimals: instrument === "native" ? 18 : 6,
  usdValue: "1",
  cash: instrument !== "native",
  priceId: null,
});

// The wallet of the live test of 2026-11-13, brought home from hosted Auni: MON on Monad, and
// USDC on Polygon and Arbitrum with none of either chain's coin. Base's fees are paid for it.
vi.mock(import("./portfolio.ts"), async (original) => ({
  ...(await original()),
  readPortfolioShared: async () =>
    ({
      holdings: [
        held("monad", "native", "68.79"),
        held("monad", NETWORKS.monad.usdc, "1.33"),
        held("polygon", NETWORKS.polygon.usdc, "5.58"),
        held("arbitrum", NETWORKS.arbitrum.usdc, "5.50"),
        held("arbitrum", "native", "0"),
      ],
    }) as never,
}));
vi.mock(import("./wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => "0x2222222222222222222222222222222222222222",
  paysOwnGas: async (chain: number | "solana") => chain !== NETWORKS.base.viem.id,
}));
vi.mock(import("./gas.ts"), () => ({ ownGas: vi.fn(), ownGasFees: vi.fn() }));

describe("whereFeesArePaid", () => {
  it("says beside a refusal where moves pay their way now, and what can't leave until the chain's coin arrives", async () => {
    const said = await whereFeesArePaid(new NoFeeCoin("Too little POL for gas."));
    expect(said.message).toBe(
      "Too little POL for gas. Right now the wallet holds some of the chain's own coin for fees on Monad, and fees are paid for it on Base. What it holds on Arbitrum and Polygon can't leave until some of that chain's own coin (ETH or POL) arrives there, which the owner can send to their own address. Propose moves that start where fees can be paid, or tell the owner what's missing.",
    );
  });
});

// Every card is drawn through prepareLeg, so the fee check is made once, there, for whatever
// recipe says what its card would send (how the coin is bought is drilled beside the app that
// carries it, apps/relay/fee-coin.held.test.ts).
describe("a card whose recipe says what it would send", () => {
  const calls = [{ to: "0x3333333333333333333333333333333333333333", data: "0x" }];
  const recipe = (chainId: number) =>
    ({
      tool: "send_evm_transaction",
      input: {},
      describe: async () => ({
        summary: "Do a thing on Polygon",
        amountUsd: "1",
        effect: { gives: [], gets: [], grants: [] },
        sends: { chainId, calls },
      }),
    }) as unknown as Recipe;

  it("is checked against the chain's fees, and is no card where the wallet is short and nothing can buy the coin", async () => {
    vi.mocked(ownGas).mockResolvedValue({ short: "Too little POL for gas.", fee: 1n });
    await expect(prepareLeg(recipe(137), {})).rejects.toThrow(
      "Too little POL for gas. Right now the wallet holds some of the chain's own coin for fees on Monad",
    );
    expect(ownGas).toHaveBeenLastCalledWith(137, expect.any(String), calls);
  });

  it("is drawn as the recipe made it where the wallet can pay, or a sponsor does", async () => {
    vi.mocked(ownGas).mockResolvedValue({ short: null, fee: 1n });
    const { preview } = await prepareLeg(recipe(137), {});
    expect(preview.details).toBeUndefined();
    vi.mocked(ownGas).mockClear();
    await prepareLeg(recipe(NETWORKS.base.viem.id), {});
    expect(ownGas).not.toHaveBeenCalled();
  });
});
