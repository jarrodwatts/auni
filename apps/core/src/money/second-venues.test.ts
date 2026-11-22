import { EVM_CHAIN_KEYS, NETWORKS } from "@auni/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { systemPrompt } from "../agent/prompt.ts";
import { toolsFor } from "../agent/mcp.ts";
import type { ThreadRow } from "../db/schema.ts";
import { accounts, ledgerAt, appById, apps } from "../apps/registry.ts";
import { BRIDGE, bridgeQuote, bridgeSend } from "../test/second-venues/bridge.ts";
import { SECOND_VENUES } from "../test/second-venues/index.ts";
import { PERPS } from "../test/second-venues/perps.ts";
import { COLLATERAL, PREDICTIONS, SNOW } from "../test/second-venues/predictions.ts";
import { SAVINGS, SAVINGS_TOKEN } from "../test/second-venues/savings.ts";
import { SOLANA_ROUTE } from "../test/second-venues/solana-route.ts";
import { sharePrice, VAULT, VAULT_SHARES } from "../test/second-venues/vault.ts";
import { expectKindsKept, expectOwnOnlyTheirOwn } from "../test/venue-rules.ts";
import { placeName } from "./chains.ts";
import { cashCents, spendsAsChainCash, uncoveredAccounts, withdrawalFeeUsd } from "./funding.ts";
import { livePrices, priceKey, readPaths } from "./history.ts";
import { holdingFaces, tokenArt } from "./holdings.ts";
import { searchInstruments } from "./instruments.ts";
import { priceHoldings, type Holding } from "./portfolio.ts";
import { stagedLeg } from "./proposal-order.ts";
import { NothingMoved, type Signer } from "./recipe.ts";
import { withdrawUsdc } from "./recipes/withdraw.ts";
import { previewEvmSwap } from "./swaps/evm-swap.ts";
import { resolveEvmToken } from "./swaps/evm.ts";
import { previewSolanaSwap } from "./swaps/solana-swap.ts";
import { destinationAddress } from "./withdrawals.ts";

// A second venue of each kind (test/second-venues/), installed beside the real apps as
// `pnpm gen` would install a new folder, reaches the agent's tools, its cards and the owner's
// cash with no line of core changed, but for the line the bridge and the Solana route each
// have in apps/order.ts, which says it is asked first. The real venues can't reach the network here, so each is passed over
// as any venue that can't answer is.

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
    solana: "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n",
  }),
  paysOwnGas: async () => false,
}));
/** $10 of USDC in every wallet, and tokens known without LI.FI's list. */
vi.mock(import("./swaps/evm.ts"), async (original) => ({
  ...(await original()),
  evmBalance: async () => 10_000_000n,
  resolveEvmToken: vi.fn(),
}));
vi.mock(import("./withdrawals.ts"), async (original) => ({
  ...(await original()),
  refuseTokenDestination: async () => {},
  walletUsdc: async () => new Map([["base", 50_000_000n]]),
}));

beforeAll(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in this test");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const holding = (fields: Partial<Holding> & Pick<Holding, "venue" | "chain" | "instrument">) =>
  ({
    symbol: "X",
    quantity: "1",
    decimals: 6,
    usdValue: "1.00",
    cash: false,
    priceId: null,
    ...fields,
  }) satisfies Holding;

describe("a second venue of each kind", () => {
  it("is installed beside the real one, and keeps what core asks of its kind", () => {
    const installed = apps().map(({ about }) => about.id);
    for (const second of SECOND_VENUES) {
      expect(installed).toContain(second.about.id);
      expectKindsKept(second);
    }
    expect(installed).toContain("hyperliquid");
    expectOwnOnlyTheirOwn(apps());
  });

  describe("reaches the agent", () => {
    const thread = { id: "t", turnStartedAt: null } as ThreadRow;

    it("as money tools, and in what the system prompt says Auni can do", async () => {
      const names = toolsFor({ thread }).map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["fake_perps_deposit", "fake_bridge_usdc"]));
      const prompt = await systemPrompt({ computer: "a shell", models: "a model" });
      expect(prompt).toContain("Fake perps trade on Fake Perps.");
      expect(prompt).toContain("Fake predictions trade on Fake Predictions.");
    });

    it("in find_instruments, by its name", async () => {
      const found = await searchInstruments({ query: "fake" });
      expect(found.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "index",
            tool: "fake_perps_deposit",
            identifier: "FAKE",
            venue: "Fake Perps",
          }),
          expect.objectContaining({ kind: "token", ticker: "FKS", venue: "Fake Solana" }),
        ]),
      );
    });
  });

  describe("reaches the cards", () => {
    it("as the EVM swap route that pays most", async () => {
      vi.mocked(resolveEvmToken).mockImplementation(async (chain, token) =>
        token === "USDC"
          ? { address: NETWORKS.base.usdc, symbol: "USDC", decimals: 6, usdPrice: 1 }
          : {
              address: "0x4200000000000000000000000000000000000006",
              symbol: "WETH",
              decimals: 18,
              usdPrice: 4_000,
            },
      );
      const card = await previewEvmSwap(
        { chain: "base", sellToken: "USDC", buyToken: "WETH", sellAmount: 10 },
        async () => OWNER,
      );
      expect(card.details).toMatchObject({ venue: "Fake Swap" });
    });

    it("as the Solana route that gets most, which also lists and prices the token", async () => {
      const card = await previewSolanaSwap(
        { token: "FKS", side: "buy", amountUsd: 10 },
        { owner: async () => OWNER },
      );
      expect(card.details).toMatchObject({ venue: appById(SOLANA_ROUTE)!.about.name });
      expect(card.summary).toContain("Fake Solana Token");
    });

    it("as the bridge core's own withdrawals quote through, being first", async () => {
      const card = await withdrawUsdc.describe(
        {
          amount_usd: "20",
          network: "arbitrum",
          address: "0x00000000000000000000000000000000000000b2",
          destination: "wallet",
        },
        {},
      );
      expect(bridgeQuote).toHaveBeenCalledWith(
        expect.objectContaining({ from: "base", to: "arbitrum", amount: "20.00" }),
      );
      expect(card.card?.finePrint).toBe("Includes a $0.10 fee to move it between networks.");
      expect(card.details).toMatchObject({
        bridge: BRIDGE,
        arrives: "In about a minute",
        fee: "$0.10",
      });
      expect(appById(BRIDGE)?.bridge).toBeDefined();
    });

    it("sending a withdrawal through the bridge its card was quoted on, and no other", async () => {
      const input = {
        amount_usd: "20",
        network: "arbitrum",
        address: "0x00000000000000000000000000000000000000b2",
        destination: "wallet",
      } as const;
      const withdraw = (bridge: string) =>
        withdrawUsdc.execute({
          action: {
            id: "a",
            amountUsd: "20",
            details: { from: "base", leavesTo: input.address, bridge },
          } as never,
          input,
          wallets: { evmAddress: OWNER, solanaAddress: "" } as Signer,
          recordSent: async () => {},
          specialistHolds: null,
        } as never);
      // Across, the bridge here before it, tries the network this test hasn't got.
      await expect(withdraw("across")).rejects.toThrow(/no network in this test/u);
      expect(bridgeSend).not.toHaveBeenCalled();
      await expect(withdraw(BRIDGE)).rejects.toThrow("A fake sends nothing.");
      expect(bridgeSend).toHaveBeenCalledWith(
        expect.objectContaining({ from: "base", to: "arbitrum", amount: "20.00" }),
        expect.anything(),
        expect.anything(),
      );
      await expect(withdraw("gone")).rejects.toBeInstanceOf(NothingMoved);
    });

    it("as a perps account money is staged into, held and charged like any other", async () => {
      const leg = (tool: string, amountUsd: number) =>
        stagedLeg({
          id: tool,
          status: "awaiting_permission",
          phase: null,
          tool,
          input: { amountUsd },
          details: {},
          amountUsd: String(amountUsd),
        });
      const deposit = leg("fake_perps_deposit", 20);
      expect(deposit).toMatchObject({ lands: PERPS, draws: "base" });
      expect(deposit.stage).toBe(leg("hyperliquid_deposit", 20).stage);

      expect(placeName(PERPS)).toBe("Fake Perps");
      expect(ledgerAt(PERPS)?.about.id).toBe(PERPS);
      expect(withdrawalFeeUsd(PERPS)).toBe(2);
      expect(await cashCents(PERPS)).toBe(1_234n);
      expect(await uncoveredAccounts([{ draws: PERPS, lands: null, amountUsd: "20" }])).toEqual({
        place: PERPS,
        holdsUsd: "12.34",
        shortUsd: "8.26",
      });
    });

    it("as no ledger for an app whose account is kept on chains or in the wallet, whatever its id", () => {
      for (const place of [
        PREDICTIONS,
        SAVINGS,
        VAULT,
        BRIDGE,
        SOLANA_ROUTE,
        "base",
        "eip155:43114",
      ])
        expect(ledgerAt(place), place).toBeUndefined();
      expect(ledgerAt("hyperliquid")?.about.id).toBe("hyperliquid");
    });

    it("counting a prediction market's collateral as its chain's cash, and savings apart", async () => {
      // $10 of the wallet's own USDC on Base and the market's $7 there.
      expect(await cashCents("base")).toBe(1_700n);
      const collateral = holding({ venue: PREDICTIONS, chain: "base", instrument: COLLATERAL });
      expect(spendsAsChainCash({ ...collateral, cash: true })).toBe(true);
      // Only on the chain the market counts it as cash on.
      expect(spendsAsChainCash({ ...collateral, chain: "arbitrum", cash: true })).toBe(false);
      const saved = holding({ venue: SAVINGS, chain: "base", instrument: SAVINGS_TOKEN });
      expect(spendsAsChainCash({ ...saved, cash: true })).toBe(false);
    });

    // Sending USDC to a token's own contract loses it. Every dollar token an account keeps
    // cash as is refused, read from every registered account, the real ones and these.
    it("never as a withdrawal's destination, for any account's savings token or chain cash", () => {
      const tokens = accounts().flatMap(({ about, account: { cash } }) =>
        cash?.kind === "savings"
          ? EVM_CHAIN_KEYS.flatMap((chain) => cash.token(chain)?.token ?? []).map(
              (token) => [about.id, token] as const,
            )
          : cash?.kind === "chain"
            ? cash.tokens.map((token) => [about.id, token] as const)
            : [],
      );
      expect(tokens.map(([, token]) => token)).toEqual(
        expect.arrayContaining([SAVINGS_TOKEN, COLLATERAL]),
      );
      // Aave's and Polymarket's own are among them, beside the second venues'.
      expect(new Set(tokens.map(([id]) => id))).toEqual(
        new Set(["aave", "polymarket", SAVINGS, PREDICTIONS]),
      );
      for (const [id, token] of tokens)
        for (const chain of ["base", "polygon"] as const)
          expect(
            () => destinationAddress(chain, token, { evm: OWNER, solana: null }),
            `${id} ${token}`,
          ).toThrow(/token's own address/u);
    });
  });

  describe("reaches the portfolio's faces and prices", () => {
    const perp = holding({
      venue: PERPS,
      chain: PERPS,
      instrument: "FAKE",
      quantity: "2",
      leverage: 2,
    });
    const share = holding({
      venue: PREDICTIONS,
      ...SNOW,
      symbol: "Will it snow?: Yes",
      quantity: "3",
    });
    const saved = holding({ venue: SAVINGS, chain: "base", instrument: SAVINGS_TOKEN, cash: true });

    it("named by the venue that keeps each", async () => {
      expect(await holdingFaces([saved, perp, share])).toEqual([
        expect.objectContaining({ name: "Cash", detail: "Savings on Fake Savings" }),
        expect.objectContaining({ name: "FAKE Index 2x long", detail: "2 FAKE on Fake Perps" }),
        expect.objectContaining({
          name: "Will it snow?",
          detail: "Yes, 3 shares on Fake Predictions",
        }),
      ]);
    });

    it("priced by the venue that owns each", async () => {
      const keys = [priceKey(perp), priceKey(share)];
      expect(keys).toEqual([`${PERPS}:FAKE`, `${PREDICTIONS}:777`]);
      expect(await livePrices(keys as string[])).toEqual(
        new Map([
          [`${PERPS}:FAKE`, 42],
          [`${PREDICTIONS}:777`, 0.5],
        ]),
      );
    });

    // The shares as the wallet's reader finds them: a token like any other, which core would ask
    // the public feeds about. No feed answers in this test, so a price can only be the vault's.
    const shares = {
      venue: "wallet",
      ...VAULT_SHARES,
      symbol: "fvUSDC",
      baseUnits: 241_545_893n,
      decimals: 6,
      priceId: `base:${VAULT_SHARES.instrument}`,
      cash: false,
    };
    const cash = {
      ...shares,
      instrument: NETWORKS.base.usdc,
      symbol: "USDC",
      baseUnits: 750_000_000n,
      priceId: null,
      cash: true,
    };

    it("pricing a vault's shares in the wallet at what the vault redeems them for, asking no feed", async () => {
      const { holdings, pricesRead } = await priceHoldings([cash, shares]);
      expect(pricesRead).toBe(true);
      expect(holdings).toEqual([
        expect.objectContaining({ symbol: "USDC", usdValue: "750.00" }),
        expect.objectContaining({ venue: "wallet", symbol: "fvUSDC", usdValue: "249.99" }),
      ]);
      // Its chart reads the vault too, so a day's move is never the vault's price against a feed's.
      const key = priceKey(holdings[1]!);
      expect(key).toBe(`${VAULT}:${VAULT_SHARES.instrument}`);
      expect(await readPaths([key!], "1h", 5_000)).toEqual(
        new Map([[key, [{ at: 5_000, price: 1.035 }]]]),
      );
    });

    it("picturing a vault's shares on a card as the vault, asking no feed", async () => {
      const asked = vi.fn(async () => {
        throw new Error("no network in this test");
      });
      vi.stubGlobal("fetch", asked);
      expect(await tokenArt(VAULT_SHARES.chain, VAULT_SHARES.instrument)).toBeNull();
      expect(asked).not.toHaveBeenCalled();
    });

    it("leaving the read partial, never a dip, when the vault can't say what a share is worth", async () => {
      for (const unanswered of [async () => undefined, () => Promise.reject(new Error("down"))]) {
        sharePrice.mockImplementationOnce(unanswered);
        const { holdings, pricesRead } = await priceHoldings([cash, shares]);
        expect(pricesRead).toBe(false);
        expect(holdings[1]).toMatchObject({ symbol: "fvUSDC", usdValue: null });
      }
    });

    it("pricing no other wallet token by the vault, and no venue's own holding twice", async () => {
      sharePrice.mockClear();
      const other = {
        ...shares,
        instrument: "0x000000000000000000000000000000000000fd02",
        priceId: null,
      };
      const kept = { ...shares, venue: VAULT, priceId: null, usdValue: "7.00" };
      const { holdings } = await priceHoldings([other, kept]);
      expect(holdings.map(({ usdValue }) => usdValue)).toEqual([null, "7.00"]);
      expect(sharePrice).not.toHaveBeenCalled();
    });
  });
});
