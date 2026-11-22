import { NETWORKS } from "@auni/shared";
import { getAddress } from "viem";
import { expect, vi } from "vitest";

import { evmMarket, ROUTER } from "../../test/evm-market.ts";
import { erc20Calls, holdsToCard } from "../../test/held-to-card.ts";
import { APPROVED_SALE } from "../approved.ts";
import { parseUnits } from "../usd.ts";
import type { EvmToken } from "./evm.ts";

// A wallet on Base holding $1,000 of USDC and one WETH, at $4,000 a WETH.
const USDC: EvmToken = { address: NETWORKS.base.usdc, symbol: "USDC", decimals: 6, usdPrice: 1 };
const WETH: EvmToken = {
  address: "0x4200000000000000000000000000000000000006",
  symbol: "WETH",
  decimals: 18,
  usdPrice: 4_000,
};

vi.mock(import("./evm.ts"), async (original) => ({
  ...(await original()),
  resolveEvmToken: vi.fn(),
  evmBalance: vi.fn(),
}));
vi.mock(import("./routes.ts"), async (original) => ({
  ...(await original()),
  quoteSwap: vi.fn(),
  quoteStock: vi.fn(),
}));
vi.mock(import("../wallet-effect.ts"), async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
}));
vi.mock(import("../wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
}));

const market = evmMarket("base", [USDC, WETH]);
const buy = { chain: "base", sellToken: "USDC", buyToken: "WETH", amountUsd: 500 };
const sale = { chain: "base", sellToken: "WETH", buyToken: "USDC", sellAmount: 0.5 };

holdsToCard("evm_swap", {
  world: () =>
    market.open(
      new Map([
        [USDC.address, parseUnits("1000", 6)],
        [WETH.address, parseUnits("1", 18)],
      ]),
    ),
  asShown: { "a buy of WETH with $500": buy, "a sale of half a WETH": sale },
  paysAsShown(signed, card) {
    // One batch on Base: an approval of exactly the sale, to the route, then the route itself.
    expect(signed.evm).toHaveLength(1);
    const [{ chainId, txs }] = signed.evm as [(typeof signed.evm)[number]];
    expect(chainId).toBe(NETWORKS.base.viem.id);
    expect(txs.at(-1)?.to).toBe(ROUTER);
    const [approval, ...others] = erc20Calls(signed);
    expect(others).toEqual([]);
    expect(approval).toMatchObject({
      token: getAddress(card.details.sellToken!),
      call: "approve",
      to: ROUTER,
    });
    const most =
      card.details.sellToken === USDC.address
        ? (parseUnits(card.amountUsd, 6) * 10_100n) / 10_000n
        : parseUnits(card.details[APPROVED_SALE]!, 18);
    expect(approval!.units).toBeLessThanOrEqual(most);
  },
  priceMoved: {
    "a buy, once WETH costs 3% more": {
      input: buy,
      after: () => market.usd.set(WETH.address, 4_120),
    },
    "a sale, once WETH is worth 3% less": {
      input: sale,
      after: () => market.usd.set(WETH.address, 3_880),
    },
  },
  takesMore: {
    "a sale of all its WETH, once more WETH arrived after the card": {
      input: { chain: "base", sellToken: "WETH", buyToken: "USDC" },
      after: () => market.held.set(WETH.address, parseUnits("1.5", 18)),
    },
    "a buy with all its USDC, once more USDC arrived after the card": {
      input: { chain: "base", sellToken: "USDC", buyToken: "WETH" },
      after: () => market.held.set(USDC.address, parseUnits("1100", 6)),
    },
  },
  paysElsewhere: {
    "the route's bytes pay what it buys to someone else": {
      input: buy,
      after: () => {
        market.bytes = "pay a stranger";
      },
    },
    "the route's bytes leave someone a lasting approval over the wallet": {
      input: buy,
      after: () => {
        market.bytes = "leave an approval";
      },
    },
  },
});
