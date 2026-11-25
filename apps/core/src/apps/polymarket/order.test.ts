import { decodeFunctionData, parseAbi, type Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { walletsFor } from "../../test/wallets.ts";
import type { ActionRow } from "../../db/schema.ts";
import { publicClient } from "../../money/chains.ts";
import { insideApproved, PriceMoved } from "../../money/approved.ts";
import { withPermissions } from "../../money/card-face.ts";
import { effectLines } from "../../money/effect.ts";
import { moneyOf } from "../../money/recipe.ts";
import { feeTerms, orderBook, postOrder } from "./clob.ts";
import { CONTRACTS } from "./http.ts";
import { polymarketOrder } from "./order.ts";
import { runBatch } from "./relayer.ts";

const WALLET = "0x2222222222222222222222222222222222222222";

// Five shares bid at 50¢ on top of a hundred at 40¢, a hundred offered at 60¢, and no fee.
vi.mock(import("./clob.ts"), async (original) => ({
  ...(await original()),
  orderBook: vi.fn(async () => ({
    asks: [{ price: "0.60", size: "100" }],
    bids: [
      { price: "0.40", size: "100" },
      { price: "0.50", size: "5" },
    ],
  })),
  feeTerms: vi.fn(async () => ({ rateMicros: 0n, exponent: 0n })),
  apiCredentials: vi.fn(async () => ({
    address: WALLET,
    apiKey: "key",
    secret: "c2VjcmV0",
    passphrase: "pass",
  })),
  refreshBalances: vi.fn(async () => {}),
  // The book takes an order and fills none of it, so nothing more is read back.
  postOrder: vi.fn(async () => ({
    orderId: "o",
    status: "unmatched",
    transactionHashes: [],
    tradeIds: [],
  })),
  tradeHashes: vi.fn(async (): Promise<string[]> => []),
}));
// A deployed deposit wallet already holding the pUSD a buy spends, and allowed to spend it.
vi.mock(import("./wallet.ts"), async (original) => ({
  ...(await original()),
  depositWallet: vi.fn(async () => ({ address: WALLET as Address, deployed: true })),
  fundBuy: vi.fn(async () => ({ funding: { calls: [] }, txs: [] })),
  pusdApprovalCalls: vi.fn(async () => []),
  heldShares: vi.fn(async () => 10_000_000n),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: vi.fn(async () => WALLET),
}));
vi.mock(import("./relayer.ts"), async (original) => ({
  ...(await original()),
  ensureDeployed: vi.fn(async () => {}),
  runBatch: vi.fn(async () => "0xsetup"),
}));
vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  resolveOutcome: vi.fn(async () => ({
    conditionId: `0x${"11".repeat(32)}` as const,
    question: "Will it rain?",
    tokens: [],
    tickMicros: 10_000n,
    acceptingOrders: true,
    protocol: {
      version: "v1" as const,
      exchange: {
        address: "0xE111180000d2663C0091e4f400237545B87B996B" as const,
        version: "2" as const,
      },
      shares: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as const,
      assetType: "CONDITIONAL" as const,
      spenders: ["0xE111180000d2663C0091e4f400237545B87B996B" as const],
    },
    outcome: "Yes",
    tokenId: 1n,
  })),
}));

// Whether the deposit wallet has already let Polymarket's contracts move its shares.
const approvedAlready = (approved: boolean) =>
  vi.spyOn(publicClient("polygon"), "readContract").mockResolvedValue(approved as never);
beforeEach(() => approvedAlready(true));
const sell = async (input: { shares: number }) => {
  const order = { market: "rain", outcome: "Yes", side: "sell" as const, ...input };
  const { amountUsd, details = {} } = await polymarketOrder.describe(order, {});
  return { input: order, details, run: {}, amountUsd };
};

describe("polymarketOrder", () => {
  it("records what a sale at market gets back as execute sends it: deep enough to fill", async () => {
    // Ten shares fill down to 40¢, and the card allows a tick under it: $3.90.
    const sold = await sell({ shares: 10 });
    expect(sold.amountUsd).toBe("0");
    expect(sold.details).toEqual({ priceAtLeast: "0.39", returnsUsd: "3.90" });
    expect(moneyOf(sold)).toEqual({ flow: "back", usd: "3.90" });
  });

  it("offers a sale at market worth under $1, which Polymarket takes", async () => {
    // One share at 50¢, a tick under it at worst: a buy this small would be refused.
    const small = await sell({ shares: 1 });
    expect(small.details).toEqual({ priceAtLeast: "0.49", returnsUsd: "0.49" });
  });

  it("never offers an order Polymarket would refuse", async () => {
    const buy = { market: "rain", outcome: "Yes", side: "buy" as const };
    await expect(polymarketOrder.describe({ ...buy, amountUsd: 0.5 }, {})).rejects.toThrow(
      "Polymarket refuses a buy under $1",
    );
  });

  // First-time setup is granted from the owner's deposit wallet, so it reaches only what's there.
  it("names on a card the powers its setup grants, until they're granted", async () => {
    approvedAlready(false);
    const buy = { market: "rain", outcome: "Yes", side: "buy" as const, amountUsd: 10 };
    const { effect } = await polymarketOrder.describe(buy, {});
    expect(effect.grants).toEqual([
      { lets: "Polymarket collect your winnings when a market resolves", reach: "venue" },
    ]);
    const sale = await polymarketOrder.describe(
      { market: "rain", outcome: "Yes", side: "sell", shares: 10 },
      {},
    );
    expect(effectLines(sale.effect)).toContainEqual({
      label: "Lets",
      value: "Polymarket's exchanges trade the shares in your Polymarket wallet",
    });
    approvedAlready(true);
    expect((await polymarketOrder.describe(buy, {})).effect.grants).toEqual([]);
  });

  // The web draws a face, not the lines, so the face a first sale stores must say it too.
  it("says on a first sale's card the permission it grants, and none once granted", async () => {
    const order = { market: "rain", outcome: "Yes", side: "sell" as const, shares: 10 };
    approvedAlready(false);
    const first = await polymarketOrder.describe(order, {});
    expect(withPermissions(first.card!, first.effect).warning).toBe(
      "From now on, it lets Polymarket's exchanges trade the shares in your Polymarket wallet.",
    );
    approvedAlready(true);
    const again = await polymarketOrder.describe(order, {});
    expect(withPermissions(again.card!, again.effect).warning).toBeUndefined();
  });
});

describe("a buy's setup", () => {
  const sharesAbi = parseAbi(["function setApprovalForAll(address operator, bool approved)"]);
  const lets = "Polymarket collect your winnings when a market resolves";
  const buy = async (approved: boolean, shown = [{ label: "Lets", value: lets }]) => {
    vi.mocked(runBatch).mockClear();
    approvedAlready(approved);
    const order = { market: "rain", outcome: "Yes", side: "buy" as const, amountUsd: 10 };
    await polymarketOrder.execute({
      input: order,
      wallets: walletsFor(`0x${"11".repeat(32)}`),
      action: {
        amountUsd: "20",
        details: { priceAtMost: "0.6" },
        lines: shown,
      } as unknown as ActionRow,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });
    return vi.mocked(runBatch).mock.calls.map(([, , batch]) => batch.calls);
  };

  it("lets Polymarket's AutoRedeemer collect the wallet's shares on both protocols", async () => {
    const [calls] = await buy(false);
    expect(
      calls?.map((call) => ({
        target: call.target,
        args: decodeFunctionData({ abi: sharesAbi, data: call.data }).args,
      })),
    ).toEqual([
      { target: CONTRACTS.conditionalTokens, args: [CONTRACTS.autoRedeemer, true] },
      { target: CONTRACTS.positionManager, args: [CONTRACTS.autoRedeemer, true] },
    ]);
  });

  it("sends no setup once it may, and nothing else is missing", async () => {
    expect(await buy(true)).toEqual([]);
  });

  // On a specialist's own, or on a tap, nothing grants a power its card didn't name.
  it("sends nothing whose setup would grant a power its card didn't name", async () => {
    await expect(buy(false, [])).rejects.toThrow(`This would now let ${lets}`);
    expect(runBatch).not.toHaveBeenCalled();
  });
});

// A card never expires and a specialist can run it on its own, so whenever it runs, it fills no
// worse than its card showed.
describe("an order's approved price", () => {
  const order = { market: "rain", outcome: "Yes" };
  const card = async (
    input: { side: "buy"; amountUsd: number } | { side: "sell"; shares: number },
  ) => {
    const { amountUsd, details = {} } = await polymarketOrder.describe({ ...order, ...input }, {});
    return { amountUsd, details, lines: [] } as unknown as ActionRow;
  };
  const run = (
    input: { side: "buy"; amountUsd: number } | { side: "sell"; shares: number },
    action: ActionRow,
  ) =>
    polymarketOrder.execute({
      input: { ...order, ...input },
      wallets: walletsFor(`0x${"11".repeat(32)}`),
      action,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });
  // The book once the card was drawn, for its next read: every bid at 2¢, every offer at 95¢.
  const moved = () =>
    vi.mocked(orderBook).mockResolvedValueOnce({
      asks: [{ price: "0.95", size: "1000" }],
      bids: [{ price: "0.02", size: "1000" }],
    });
  beforeEach(() => vi.mocked(postOrder).mockClear());

  it("pins the most a buy pays: a tick past the offer deep enough to fill it", async () => {
    expect((await card({ side: "buy", amountUsd: 10 })).details).toEqual({ priceAtMost: "0.61" });
  });

  it("still fills once the book ticks against its card, inside the card's worst price", async () => {
    const sale = await card({ side: "sell", shares: 10 });
    // The card filled down to 40¢ and allows 39¢; the bids are a tick lower now.
    vi.mocked(orderBook).mockResolvedValueOnce({
      asks: [{ price: "0.60", size: "100" }],
      bids: [{ price: "0.39", size: "100" }],
    });
    await run({ side: "sell", shares: 10 }, sale);
    expect(postOrder).toHaveBeenCalledOnce();
  });

  // The agent and the card's receipt are told what it filled, not left to read balances.
  it("says what a sale filled: the shares, the price each, and what came back", async () => {
    const sale = await card({ side: "sell", shares: 10 });
    vi.mocked(postOrder).mockResolvedValueOnce({
      orderId: "o",
      status: "matched",
      transactionHashes: ["0xfill"],
      tradeIds: [],
      makingAmount: "10",
      takingAmount: "4.5",
    });
    const result = await run({ side: "sell", shares: 10 }, sale);
    expect(result.fills).toMatchObject([{ side: "sell", quantity: "10", usdValue: "4.5" }]);
    expect(result.run).toEqual({
      filled: "Sold 10 Yes shares at 45¢ each, $4.50 back after Polymarket's fee",
    });
  });

  // What a pot counts as spent or brought back is a fill's dollars after Polymarket's fee: on top
  // of a buy, out of a sale. Here the fee is 5% of p(1 - p) a share.
  describe("at a real fee rate", () => {
    beforeEach(() => vi.mocked(feeTerms).mockResolvedValue({ rateMicros: 50_000n, exponent: 1n }));
    afterEach(() => vi.mocked(feeTerms).mockResolvedValue({ rateMicros: 0n, exponent: 0n }));

    it("counts a buy as the cash it paid and the fee on top", async () => {
      const buy = await card({ side: "buy", amountUsd: 6 });
      vi.mocked(postOrder).mockResolvedValueOnce({
        orderId: "o",
        status: "matched",
        transactionHashes: ["0xfill"],
        tradeIds: [],
        makingAmount: "6",
        takingAmount: "10",
      });
      const result = await run({ side: "buy", amountUsd: 6 }, buy);
      // 10 shares at 60¢: a fee of 0.05 x 0.6 x 0.4 = 1.2¢ each, 12¢ in all.
      expect(result.fills).toMatchObject([{ side: "buy", quantity: "10", usdValue: "6.12" }]);
      expect(result.run).toEqual({
        filled: "Bought 10 Yes shares at 60¢ each, $6.12 with Polymarket's fee",
      });
    });

    it("counts a sale as what came back less the fee", async () => {
      const sale = await card({ side: "sell", shares: 10 });
      vi.mocked(postOrder).mockResolvedValueOnce({
        orderId: "o",
        status: "matched",
        transactionHashes: ["0xfill"],
        tradeIds: [],
        makingAmount: "10",
        takingAmount: "4.5",
      });
      const result = await run({ side: "sell", shares: 10 }, sale);
      // 10 shares at 45¢: a fee of 0.05 x 0.45 x 0.55 = 1.2375¢ each.
      expect(result.fills).toMatchObject([{ side: "sell", quantity: "10", usdValue: "4.37625" }]);
      expect(result.run).toEqual({
        filled: "Sold 10 Yes shares at 45¢ each, $4.38 back after Polymarket's fee",
      });
    });
  });

  it("sends no sale once the bids fall past its card, however long it waited", async () => {
    const sale = await card({ side: "sell", shares: 10 });
    moved();
    await expect(run({ side: "sell", shares: 10 }, sale)).rejects.toThrow(PriceMoved);
    expect(postOrder).not.toHaveBeenCalled();
  });

  it("sends no buy once the offers rise past its card", async () => {
    const buy = await card({ side: "buy", amountUsd: 10 });
    moved();
    await expect(run({ side: "buy", amountUsd: 10 }, buy)).rejects.toThrow(PriceMoved);
    expect(postOrder).not.toHaveBeenCalled();
  });

  // Polymarket cancels what it can't fill at the order's own price, so none of it goes worse.
  it("signs an order for no worse than its card's price, once only the book's depth moved", async () => {
    const signed = async () => {
      const [[, body]] = vi.mocked(postOrder).mock.calls as unknown as [[unknown, string]];
      vi.mocked(postOrder).mockClear();
      return JSON.parse(body).order as { makerAmount: string; takerAmount: string };
    };
    // Ten shares to sell fill down to 40¢ on the card, which allows 39¢, and down to 30¢ now.
    const sale = await card({ side: "sell", shares: 10 });
    vi.mocked(orderBook).mockResolvedValueOnce({
      asks: [{ price: "0.60", size: "100" }],
      bids: [
        { price: "0.30", size: "100" },
        { price: "0.50", size: "5" },
      ],
    });
    await run({ side: "sell", shares: 10 }, sale);
    // Ten shares for at least $3.90: 39¢ each, the card's worst.
    expect(await signed()).toMatchObject({ makerAmount: "10000000", takerAmount: "3900000" });
    // $10 of shares fill at 60¢ on the card, which allows 61¢, and up to 90¢ now.
    const buy = await card({ side: "buy", amountUsd: 10 });
    vi.mocked(orderBook).mockResolvedValueOnce({
      asks: [
        { price: "0.90", size: "100" },
        { price: "0.60", size: "5" },
      ],
      bids: [{ price: "0.50", size: "100" }],
    });
    await run({ side: "buy", amountUsd: 10 }, buy);
    // $10 for at least 16.3934 shares: 61¢ each, the card's worst.
    expect(await signed()).toMatchObject({ makerAmount: "10000000", takerAmount: "16393400" });
  });

  it("sends nothing on a card that pinned no price", async () => {
    await expect(
      run({ side: "sell", shares: 10 }, {
        amountUsd: "0",
        details: {},
        lines: [],
      } as unknown as ActionRow),
    ).rejects.toThrow("doesn't say the worst price");
    expect(postOrder).not.toHaveBeenCalled();
  });

  // Try again quotes a failed step held to its card, as execute would run it.
  it("prices a retry as outside its card while the book is past it, and inside once it's back", async () => {
    const sale = await card({ side: "sell", shares: 10 });
    moved();
    await expect(
      polymarketOrder.describe({ ...order, side: "sell", shares: 10 }, { heldTo: sale }),
    ).rejects.toThrow(PriceMoved);
    const again = await polymarketOrder.describe(
      { ...order, side: "sell", shares: 10 },
      { heldTo: sale },
    );
    expect(insideApproved(sale, { details: again.details ?? {} })).toBe(true);
    expect(insideApproved(sale, { details: { ...again.details, priceAtLeast: "0.38" } })).toBe(
      false,
    );
  });
});
