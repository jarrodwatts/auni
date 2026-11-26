import { NETWORKS } from "@auni/shared";
import { describe, expect, it, vi } from "vitest";

import { plannedCash, prepareLegs } from "./actions.ts";
import { largestShortfall } from "./funding.ts";
import { solForFees, withTopUp } from "./sol-top-up.ts";

// A wallet paying its own way, with $2.31 of USDC on Monad, buying SOL through the pay-in
// service; what each purchase is made of is checked in sol-top-up.test.ts.
vi.mock(import("./wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: async () => ({
    evm: "0x000000000000000000000000000000000000dEaD",
    solana: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  }),
  paysOwnGas: async () => true,
  makeWalletIfNone: async () => {},
}));
vi.mock(import("./chains.ts"), async (original) => ({
  ...(await original()),
  publicClient: () => ({ readContract: async () => 2_310_000n }) as never,
}));
vi.mock(import("./token-feeds.ts"), async (original) => ({
  ...(await original()),
  solUsd: async () => 100,
}));
vi.mock(import("./gas.ts"), async (original) => ({
  ...(await original()),
  ownGas: async () => null,
}));
vi.mock(import("./pay-in.ts"), async (original) => ({
  ...(await original()),
  payInQuote: async () =>
    ({
      by: "Relay",
      least: 10_000_000n,
      requestId: "0xorder",
      steps: ["approve", "deposit"].map((id) => ({
        id,
        call: { chainId: 143, to: NETWORKS.monad.usdc, data: "0x", value: 0n },
      })),
    }) as never,
}));
// The moves of the card, standing in for the recipes the agent names.
const recipes = vi.hoisted(() => ({ byTool: new Map<string, unknown>() }));
vi.mock(import("./recipes/index.ts"), async (original) => ({
  ...(await original()),
  toolRecipe: ((tool: string) => recipes.byTool.get(tool)) as never,
  recipeForTool: ((tool: string) => recipes.byTool.get(tool)) as never,
}));

// As "buy 1 dollar of palantir" did live: propose_actions with a bridge from Monad to Solana and
// the buy there came back "Monad holds $2.31 of cash, and it spends $3.20 there: $0.89 short",
// since the cash a card is checked for counted each leg's own dollar of SOL, before the card
// bought it once. Monad holds $2.31: the $1.20 bridge and one dollar of SOL fit.
describe("the cash a card that buys SOL once is checked for", () => {
  const OPENS = 2_694_520n;
  const BUYS = 2_214_800n;
  const move = (summary: string, amountUsd: string, lamports: bigint, spends = 0n) => ({
    input: {},
    describe: async () =>
      withTopUp(
        { summary, amountUsd, effect: { gives: [], gets: [], grants: [] }, details: {} },
        await solForFees(lamports, { spends }),
      ),
  });

  it("counts one purchase of SOL, for a bridge into Solana and a stock buy there", async () => {
    recipes.byTool.set("bridge_usdc", {
      tool: "bridge_usdc",
      ...move("Move $1.20 of USDC from Monad to Solana", "1.20", OPENS),
      fundedFrom: () => "monad",
      readies: () => "solana",
    });
    recipes.byTool.set("stock_trade", {
      tool: "stock_trade",
      ...move("Buy about $1 of Palantir xStock on Solana", "1.00", BUYS, 1_000_000n),
      fundedFrom: () => "solana",
    });
    const { prepared, problems } = await prepareLegs([
      { tool: "bridge_usdc", input: {}, label: "bridge_usdc" },
      { tool: "stock_trade", input: {}, label: "stock_trade" },
    ]);
    expect(problems).toEqual([]);
    const held = new Map([
      ["monad", 231n],
      ["solana", 0n],
    ] as const);
    const cash = prepared.map(plannedCash);
    expect(cash.map(({ feeCash }) => feeCash)).toEqual([{ from: "monad", usd: "1.00" }, undefined]);
    expect(largestShortfall(cash, held)).toBeNull();
    // With 30 cents less on Monad it is short, by what the one purchase leaves.
    expect(largestShortfall(cash, new Map([...held, ["monad", 201n]]))).toEqual({
      chain: "monad",
      needUsd: "0.19",
    });
  });
});
