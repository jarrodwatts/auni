import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { toolsFor } from "../agent/mcp.ts";
import { db } from "../db/client.ts";
import {
  actions,
  arrivalCursors,
  arrivals,
  fills,
  otherTokens,
  threads,
} from "../db/schema.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { PERPS, perpsStatement } from "../test/second-venues/perps.ts";
import {
  PAYOUT_TOOL,
  PREDICTIONS,
  predictionPayouts,
  SNOW,
} from "../test/second-venues/predictions.ts";
import { SAVINGS, SAVINGS_TOKEN } from "../test/second-venues/savings.ts";
import { sharePrice, VAULT_SHARES } from "../test/second-venues/vault.ts";
import { recordArrivals } from "./arrivals.ts";
import { chainIdOf } from "./chains.ts";
import { fillIdentity } from "./fill-key.ts";
import { payoutSweeps } from "./payouts.ts";
import { heldNow, readPortfolio } from "./portfolio.ts";
import { statementSweeps } from "./statements.ts";
import { readTransfers } from "./transfers.ts";

// The second venues of second-venues.test.ts, where what reaches them is kept: a card from one's
// money tool, the portfolio read from their holdings, a perps statement read on, a payout recorded.

vi.mock(import("../apps/index.generated.ts"), async (original) =>
  (await import("../test/second-venues/index.ts")).withSecondVenues(await original()),
);
vi.mock(import("../apps/order.ts"), async (original) =>
  (await import("../test/second-venues/index.ts")).withTheirOrder(await original()),
);
vi.mock(import("@auni/shared"), async (original) =>
  (await import("../test/second-venues/about.ts")).withTheirListings(await original()),
);

const OWNER = "0x00000000000000000000000000000000000000a1";
vi.mock(import("./wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: async () => ({
    evm: "0x00000000000000000000000000000000000000a1",
    solana: null,
  }),
  evmAddress: async () => "0x00000000000000000000000000000000000000a1",
  paysOwnGas: async () => false,
}));
/**
 * The wallets' own tokens hold nothing, so what's read is what the venues keep, but for Fake
 * Savings' token on Base, which the wallet holds as any token and core must read only as savings.
 */
vi.mock(import("./chain-holdings.ts"), async (original) => ({
  ...(await original()),
  readEvmWallet: async (chainId, _owner, tokens) =>
    chainId === chainIdOf("base")
      ? tokens
          .filter((token) => token.toLowerCase() === SAVINGS_TOKEN)
          .map((token) => ({
            venue: "wallet",
            chain: "base",
            instrument: token,
            symbol: "fsUSDC",
            baseUnits: 3n * 10n ** 18n,
            decimals: 18,
            priceId: `base:${token}`,
            cash: false,
          }))
      : [],
  readSolanaWallet: async () => [],
  namesOf: async () => new Map(),
  // Read one token at a time (as a token that begins to count is), the wallet holds four of
  // Fake Vault's shares.
  readTokens: async (_client, _owner, tokens) =>
    tokens
      .filter((token) => token.toLowerCase() === "0x000000000000000000000000000000000000fd01")
      .map((token) => ({ token, balance: 4n * 10n ** 18n, decimals: 18, symbol: "fvSHARE" })),
}));

vi.mock(import("./transfers.ts"), async (original) => ({
  ...(await original()),
  readTransfers: vi.fn(),
}));

/**
 * Core reads savings by the token's balance, in its own decimals: Fake Savings holds $3 on Base,
 * as an 18-decimal token, and Monad's can't be read.
 */
vi.mock(import("./chains.ts"), async (original) => ({
  ...(await original()),
  evmClient: () => ({ getBlockNumber: async () => 100n }) as never,
  publicClient: () =>
    ({
      multicall: async ({ contracts }: { readonly contracts: readonly { address: string }[] }) => {
        if (contracts.some(({ address }) => address !== SAVINGS_TOKEN))
          throw new Error(`${contracts[0]?.address} can't be read here.`);
        return [3n * 10n ** 18n, 18];
      },
    }) as never,
}));

beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in this test");
  });
  for (const level of ["warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation(() => {});
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => wipe(actions, fills, threads, arrivalCursors, arrivals, otherTokens));

describe("a second venue of each kind", () => {
  it("proposes its money tool's card, filed under it, paid with cash a market holds", async () => {
    const thread = await insertThread();
    const deposit = toolsFor({ thread }).find(
      ({ name }) => name === ("fake_perps_deposit" as string),
    )!;
    // The wallet's own USDC is empty: Base's cash is the prediction market's $7.
    await expect(deposit.handler({ amountUsd: 20 })).rejects.toThrow(
      /Base holds \$7 of cash, and it spends \$20 there: \$13 short/u,
    );
    const answer = await deposit.handler({ amountUsd: 5 });
    expect(answer.structuredContent).toMatchObject({ status: "awaiting_permission" });
    const [row] = await db.select().from(actions).where(eq(actions.threadId, thread.id));
    expect(row).toMatchObject({ venue: PERPS, summary: "Move $5 into Fake Perps" });
  });

  it("is read into the portfolio, filed under it, and named when it can't be read", async () => {
    const portfolio = await readPortfolio();
    const held = (venue: string) =>
      portfolio.holdings
        .filter((holding) => holding.venue === venue)
        .map(({ chain, instrument, usdValue, cash }) => ({ chain, instrument, usdValue, cash }));
    expect(held(PERPS)).toEqual([
      { chain: PERPS, instrument: "USDC", usdValue: "12.34", cash: true },
      { chain: PERPS, instrument: "FAKE", usdValue: "5.00", cash: false },
    ]);
    expect(held(PREDICTIONS)).toEqual(
      expect.arrayContaining([{ ...SNOW, usdValue: "1.50", cash: false }]),
    );
    expect(held(SAVINGS)).toEqual([
      expect.objectContaining({ chain: "base", usdValue: "3.00", cash: true }),
    ]);
    // Free cash in the account, the market's collateral and savings are all Cash.
    expect(portfolio.cash.usdValue).toBe("22.34");
    expect(portfolio.unavailable).toContain(`${SAVINGS} monad`);
    expect(await heldNow(SNOW)).toBe(3n * 10n ** 18n);
  });

  it("reads savings bought through Auni once, as savings, never again as a wallet token", async () => {
    const bought = await insertAction({ tool: "swap", venue: "wallet", status: "done" });
    await db.insert(fills).values({
      actionId: bought.id,
      chain: "base",
      instrument: SAVINGS_TOKEN,
      side: "buy",
      quantity: "3",
      usdValue: "3.00",
    });
    const { holdings } = await readPortfolio();
    expect(
      holdings
        .filter(({ instrument }) => instrument === SAVINGS_TOKEN)
        .map(({ venue, usdValue }) => ({ venue, usdValue })),
    ).toEqual([{ venue: SAVINGS, usdValue: "3.00" }]);
  });

  // A vault's shares are a token no public list or feed knows. Sent in from outside Auni, they
  // are still the owner's money: the vault's account vouches for the token and prices it.
  it("records a vault's shares sent in from outside, at the vault's own price", async () => {
    const hash = `0x${"cd".repeat(32)}`;
    const at = new Date(Date.now() - 60_000);
    vi.mocked(readTransfers).mockResolvedValue({
      at,
      block: 100,
      walletSigned: false,
      closedAccounts: [],
      transfers: [
        {
          position: "log:1",
          instrument: VAULT_SHARES.instrument,
          decimals: 18,
          baseUnits: 4n * 10n ** 18n,
          counterparty: "0x2222222222222222222222222222222222222222",
          symbol: "A NAME ANYONE COULD GIVE",
        },
      ],
    });
    sharePrice.mockResolvedValue(1.25);
    await recordArrivals("base", hash);
    const recorded = await db.select().from(arrivals).where(eq(arrivals.txHash, hash));
    // Four shares at $1.25, named as the vault names them, and counted as money put in.
    expect(recorded).toMatchObject([
      { kind: "deposit", usdValue: "5.00", symbol: VAULT_SHARES.symbol, at },
    ]);
    // It counts from here on at that worth, never as an Other token nobody vouches for, and
    // no public list or feed was asked about it: fetch throws in this file.
    expect(await db.select().from(otherTokens)).toMatchObject([
      { instrument: VAULT_SHARES.instrument, keptUsd: "5.00", keptAt: expect.any(Date) },
    ]);
  });

  it("has its perps statement read on once money moved there", async () => {
    const sweep = () =>
      statementSweeps(async () => OWNER).find(({ app }) => app.name === "Fake Perps")!;
    await sweep().run();
    expect(perpsStatement).not.toHaveBeenCalled();

    await insertAction({ tool: "fake_perps_deposit", venue: PERPS, status: "done" });
    await sweep().run();
    expect(perpsStatement).toHaveBeenCalledWith(null);
    const [cursor] = await db.select().from(arrivalCursors).where(eq(arrivalCursors.chain, PERPS));
    expect(cursor?.block).toBe(1_000);
  });

  it("has its prediction market's payout recorded, closing the shares bought", async () => {
    const sweep = () =>
      payoutSweeps(OWNER)
        .find(({ app }) => app.name === "Fake Predictions")!
        .run();
    // A holding of another account's is never the market's to pay out, nor a reason to ask it.
    const swapped = await insertAction({ tool: "swap", venue: "wallet", status: "done" });
    await db.insert(fills).values({
      actionId: swapped.id,
      chain: "base",
      instrument: SAVINGS_TOKEN,
      side: "buy",
      quantity: "3",
      usdValue: "3.00",
    });
    predictionPayouts.mockClear();
    await sweep();
    expect(predictionPayouts).not.toHaveBeenCalled();

    const bought = await insertAction({
      tool: "fake_predictions_order",
      venue: PREDICTIONS,
      status: "done",
    });
    await db.insert(fills).values({
      actionId: bought.id,
      ...SNOW,
      side: "buy",
      quantity: "3",
      usdValue: "1.50",
    });
    const hash = `0x${"ab".repeat(32)}`;
    predictionPayouts.mockResolvedValueOnce([
      {
        hash,
        chain: "base",
        markets: [
          {
            question: "Will it snow?",
            paidMicros: 3_000_000n,
            shares: [{ key: SNOW, burned: 3n * 10n ** 18n, paidMicros: 3_000_000n }],
          },
        ],
      },
    ]);
    await sweep();
    expect(predictionPayouts).toHaveBeenCalledWith(
      OWNER,
      new Set([fillIdentity(SNOW)]),
      expect.any(Number),
      new Set(),
    );
    const [payout] = await db.select().from(actions).where(eq(actions.tool, PAYOUT_TOOL));
    expect(payout).toMatchObject({ venue: PREDICTIONS, status: "done" });
    expect(payout?.summary).toContain("Fake Predictions paid out $3");
    const sold = await db.select().from(fills).where(eq(fills.actionId, payout!.id));
    expect(sold).toEqual([
      expect.objectContaining({ side: "sell", quantity: "3.000000000000000000" }),
    ]);
  });
});
