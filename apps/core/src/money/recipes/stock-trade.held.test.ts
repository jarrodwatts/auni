import { NETWORKS } from "@auni/shared";
import { getAddress } from "viem";
import { expect, vi } from "vitest";

import { evmMarket, ROUTER } from "../../test/evm-market.ts";
import { erc20Calls, holdsToCard } from "../../test/held-to-card.ts";
import { APPROVED_SALE } from "../approved.ts";
import type { EvmToken } from "../swaps/evm.ts";
import { solanaPrice } from "../swaps/solana-swap.ts";
import { findXStock, marketNote, type XStock } from "../swaps/xstocks.ts";
import { parseUnits } from "../usd.ts";

// A wallet on Monad holding $1,000 of USDC and 5 NVIDIA shares at $200, which a route there
// trades at its Solana twin's price. On Solana a stock trade is a Solana swap, which its own
// drill holds to its card (solana-swap.held.test.ts); what this drill adds is Monad's, where
// shares are sized by that price.
const NVDA: XStock = {
  symbol: "NVDAx",
  name: "NVIDIA xStock",
  ticker: "NVDA",
  logoUrl: "https://example.com/NVDA.png",
  solanaMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  evmAddress: "0x0000000000000000000000000000000000000a11",
};
const USDC: EvmToken = { address: NETWORKS.monad.usdc, symbol: "USDC", decimals: 6, usdPrice: 1 };
const NVDAX: EvmToken = { address: NVDA.evmAddress!, symbol: "NVDAx", decimals: 18, usdPrice: 200 };

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
vi.mock(import("../swaps/xstocks.ts"), async (original) => ({
  ...(await original()),
  findXStock: vi.fn(),
  marketNote: vi.fn(),
}));
vi.mock(import("../swaps/solana-swap.ts"), async (original) => ({
  ...(await original()),
  solanaPrice: vi.fn(),
}));
vi.mock(import("../wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
}));

const market = evmMarket("monad", [USDC, NVDAX]);
/** The share's price moved to `usd`, on the route and on its twin alike. */
const shareAt = (usd: number) => market.usd.set(NVDAX.address, usd);

holdsToCard("stock_trade", {
  world() {
    market.open(
      new Map([
        [USDC.address, parseUnits("1000", 6)],
        [NVDAX.address, parseUnits("5", 18)],
      ]),
    );
    vi.mocked(findXStock).mockResolvedValue(NVDA);
    vi.mocked(marketNote).mockResolvedValue("");
    vi.mocked(solanaPrice).mockImplementation(async () => ({
      usdPrice: market.usd.get(NVDAX.address)!,
      multiplier: 1,
    }));
  },
  asShown: {
    "a buy of $100 of NVIDIA on Monad": { stock: "NVDA", side: "buy", amountUsd: 100 },
    "a buy of 2 shares": { stock: "NVDA", side: "buy", shares: 2 },
    "a sale of 2 shares": { stock: "NVDA", side: "sell", shares: 2, chain: "monad" },
  },
  paysAsShown(signed, card) {
    // One batch on Monad: an exact approval of the sale to the route, then the route itself.
    expect(card.details.chain).toBe("monad");
    expect(signed.evm).toHaveLength(1);
    expect(signed.evm[0]!.chainId).toBe(NETWORKS.monad.viem.id);
    expect(signed.evm[0]!.txs.at(-1)?.to).toBe(ROUTER);
    const [approval, ...others] = erc20Calls(signed);
    expect(others).toEqual([]);
    const buys = card.input.side === "buy";
    expect(approval).toMatchObject({
      token: getAddress(buys ? USDC.address : NVDAX.address),
      call: "approve",
      to: ROUTER,
    });
    const most = buys
      ? (parseUnits(card.amountUsd, 6) * 10_100n) / 10_000n
      : parseUnits(card.details[APPROVED_SALE]!, 18);
    expect(approval!.units).toBeLessThanOrEqual(most);
  },
  priceMoved: {
    "a buy, once a share costs 3% more": {
      input: { stock: "NVDA", side: "buy", amountUsd: 100 },
      after: () => shareAt(206),
    },
    "a sale, once a share is worth 3% less": {
      input: { stock: "NVDA", side: "sell", shares: 2, chain: "monad" },
      after: () => shareAt(194),
    },
  },
  takesMore: {
    "a buy of 2 shares, once each costs 5% more USDC": {
      input: { stock: "NVDA", side: "buy", shares: 2 },
      after: () => shareAt(210),
    },
    "a sale of $100 of shares, once each is worth 5% less, so it takes more of them": {
      input: { stock: "NVDA", side: "sell", amountUsd: 100, chain: "monad" },
      after: () => shareAt(190),
    },
    "a sale of every share, once more arrived after the card": {
      input: { stock: "NVDA", side: "sell", chain: "monad" },
      after: () => market.held.set(NVDAX.address, parseUnits("8", 18)),
    },
  },
  paysElsewhere: {
    "the route's bytes pay the shares it buys to someone else": {
      input: { stock: "NVDA", side: "buy", amountUsd: 100 },
      after: () => {
        market.bytes = "pay a stranger";
      },
    },
  },
});
