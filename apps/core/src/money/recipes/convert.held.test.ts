import { NETWORKS } from "@auni/shared";
import { getAddress } from "viem";
import { expect, vi } from "vitest";

import { evmMarket, ROUTER } from "../../test/evm-market.ts";
import { erc20Calls, holdsToCard } from "../../test/held-to-card.ts";
import { APPROVED_SALE } from "../approved.ts";
import { QUANTITY_DECIMALS } from "../fill-key.ts";
import { looseNow } from "../portfolio.ts";
import type { EvmToken } from "../swaps/evm.ts";
import { parseUnits } from "../usd.ts";

// A wallet on Base holding one WETH at $4,000 that no specialist holds, which a card converts
// to USDC to pay for its picks. It is a swap into USDC underneath, through the same route, so a
// Solana conversion is a Solana swap, which that drill holds to its card (solana-swap.held.test.ts).
const USDC: EvmToken = { address: NETWORKS.base.usdc, symbol: "USDC", decimals: 6, usdPrice: 1 };
const WETH: EvmToken = {
  address: "0x4200000000000000000000000000000000000006",
  symbol: "WETH",
  decimals: 18,
  usdPrice: 4_000,
};

const loose = vi.hoisted(() => ({ units: 0n }));

vi.mock(import("../swaps/evm.ts"), async (original) => ({
  ...(await original()),
  resolveEvmToken: vi.fn(),
  evmBalance: vi.fn(),
}));
vi.mock(import("../swaps/routes.ts"), async (original) => ({
  ...(await original()),
  quoteSwap: vi.fn(),
  quoteStock: vi.fn(),
}));
vi.mock(import("../wallet-effect.ts"), async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
}));
vi.mock(import("../portfolio.ts"), async (original) => ({
  ...(await original()),
  looseNow: vi.fn(),
}));
vi.mock(import("../wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
}));

const market = evmMarket("base", [USDC, WETH]);
const half = { chain: "base", token: WETH.address, amount: "0.5" };

holdsToCard("convert_to_cash", {
  world() {
    market.open(
      new Map([
        [USDC.address, 0n],
        [WETH.address, parseUnits("1", 18)],
      ]),
    );
    loose.units = parseUnits("1", QUANTITY_DECIMALS);
    vi.mocked(looseNow).mockImplementation(async () => loose.units);
  },
  asShown: { "half a WETH on Base": half },
  paysAsShown(signed, card) {
    // An exact approval of what it sells to the route, then the route, on Base.
    expect(signed.evm).toHaveLength(1);
    expect(signed.evm[0]!.txs.at(-1)?.to).toBe(ROUTER);
    expect(erc20Calls(signed)).toEqual([
      {
        chainId: NETWORKS.base.viem.id,
        token: getAddress(WETH.address),
        call: "approve",
        to: ROUTER,
        units: parseUnits(card.details[APPROVED_SALE]!, 18),
      },
    ]);
  },
  priceMoved: {
    "once WETH is worth 3% less": {
      input: half,
      after: () => market.usd.set(WETH.address, 3_880),
    },
  },
  takesMore: {
    "once a specialist came to hold some of it after the card": {
      input: half,
      after: () => {
        loose.units = parseUnits("0.25", QUANTITY_DECIMALS);
      },
    },
  },
  paysElsewhere: {
    "the route's bytes pay the USDC to someone else": {
      input: half,
      after: () => {
        market.bytes = "pay a stranger";
      },
    },
  },
});
