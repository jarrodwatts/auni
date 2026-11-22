import type { Address } from "viem";
import { expect, vi } from "vitest";

import { publicClient } from "../../money/chains.ts";
import { APPROVED_SALE } from "../../money/approved.ts";
import { parseUnits } from "../../money/usd.ts";
import { holdsToCard } from "../../test/held-to-card.ts";
import { fundBuy } from "./wallet.ts";

// The owner's deposit wallet holds 100 Yes shares and is already set up to trade. The book
// offers Yes at `ask` and bids `bid`, deep enough to fill anything here, and Polymarket charges
// `feeMicros` a share on a buy.
const WALLET = "0x2222222222222222222222222222222222222222" as Address;
const TOKEN_ID = 7n;

const world = vi.hoisted(() => ({ ask: "0.60", bid: "0.50", feeMicros: 10_000n, shares: 0n }));

vi.mock(import("./clob.ts"), async (original) => ({
  ...(await original()),
  orderBook: vi.fn(async () => ({
    asks: [{ price: world.ask, size: "10000" }],
    bids: [{ price: world.bid, size: "10000" }],
  })),
  feeTerms: vi.fn(async () => ({ rateMicros: world.feeMicros, exponent: 0n })),
  apiCredentials: vi.fn(async () => ({
    address: "0x2222222222222222222222222222222222222222",
    apiKey: "key",
    secret: "c2VjcmV0",
    passphrase: "pass",
  })),
  refreshBalances: vi.fn(async () => {}),
  // The book takes the order and fills none of it, so nothing more is read back.
  postOrder: vi.fn(async () => ({
    orderId: "o",
    status: "unmatched",
    transactionHashes: [],
    tradeIds: [],
  })),
  tradeHashes: vi.fn(async (): Promise<string[]> => []),
}));
vi.mock(import("./wallet.ts"), async (original) => ({
  ...(await original()),
  depositWallet: vi.fn(async () => ({
    address: "0x2222222222222222222222222222222222222222" as Address,
    deployed: true,
  })),
  fundBuy: vi.fn(async () => ({ funding: { calls: [] }, txs: [] })),
  pusdApprovalCalls: vi.fn(async () => []),
  heldShares: vi.fn(async () => world.shares),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
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
    tokenId: 7n,
  })),
}));

const buy = (amountUsd: number) => ({ market: "rain", outcome: "Yes", side: "buy", amountUsd });
const sell = (more: Record<string, unknown>) => ({
  market: "rain",
  outcome: "Yes",
  side: "sell",
  ...more,
});

holdsToCard("polymarket_order", {
  world() {
    Object.assign(world, { ask: "0.60", bid: "0.50", feeMicros: 10_000n, shares: 100_000_000n });
    vi.mocked(fundBuy).mockClear();
    // The deposit wallet has let Polymarket's exchanges trade already.
    vi.spyOn(publicClient("polygon"), "readContract").mockResolvedValue(true as never);
  },
  asShown: {
    "a buy of $20 of Yes": buy(20),
    "a sale of 30 Yes shares": sell({ shares: 30 }),
  },
  paysAsShown(signed, card) {
    // One order, signed for the owner's own deposit wallet, trading the card's outcome.
    expect(signed.evm).toEqual([]);
    expect(signed.typed).toHaveLength(1);
    const order = signed.typed[0]!.message.contents as Record<string, string>;
    expect(order).toMatchObject({
      maker: WALLET.toLowerCase(),
      signer: WALLET.toLowerCase(),
      tokenId: String(TOKEN_ID),
      side: card.input.side === "buy" ? 0 : 1,
    });
    if (card.input.side === "buy") {
      // It pays no more cash than the card, fees on top, and is funded no more than that.
      const most = parseUnits(card.amountUsd, 6);
      expect(BigInt(order.makerAmount!)).toBeLessThanOrEqual(most);
      expect(vi.mocked(fundBuy).mock.lastCall?.[1]).toBe(WALLET);
      expect(vi.mocked(fundBuy).mock.lastCall?.[2]).toBeLessThanOrEqual(most);
    } else {
      expect(BigInt(order.makerAmount!)).toBeLessThanOrEqual(
        parseUnits(card.details[APPROVED_SALE]!, 6),
      );
    }
  },
  priceMoved: {
    "a buy, once the best offer is past the worst price its card allowed": {
      input: buy(20),
      after: () => {
        world.ask = "0.65";
      },
    },
    "a sale, once the best bid is under the worst price its card allowed": {
      input: sell({ shares: 30 }),
      after: () => {
        world.bid = "0.45";
      },
    },
  },
  takesMore: {
    "a buy, once Polymarket's fee rose past what its card allowed": {
      input: buy(20),
      after: () => {
        world.feeMicros = 60_000n;
      },
    },
    "a sale of every share, once more arrived after the card": {
      input: sell({}),
      after: () => {
        world.shares = 150_000_000n;
      },
    },
  },
  paysElsewhere: {
    never:
      "an order trades only in the owner's own deposit wallet, which signs it, and paysAsShown reads that it does",
  },
});
