import { NETWORKS } from "@auni/shared";
import { describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../db/schema.ts";

import {
  bridgesFor,
  idleBridges,
  largestShortfall,
  shortfallSaid,
  spendsAsChainCash,
  uncoveredAccounts,
} from "./funding.ts";
import { stagedLeg } from "./proposal-order.ts";
import { pinnedSol } from "../test/sol.ts";

const spend = (draws: "solana" | "monad" | "base" | "polygon", amountUsd: string) => ({
  draws,
  lands: null,
  amountUsd,
});

describe("largestShortfall", () => {
  it("sums one chain's legs before comparing with its balance", () => {
    const legs = [spend("solana", "20.00"), spend("solana", "30.00")];
    expect(largestShortfall(legs, new Map([["solana", 2_650n]]))).toEqual({
      chain: "solana",
      needUsd: "23.50",
    });
  });

  it("returns the chain short by the most, and nothing once every chain is covered", () => {
    const legs = [spend("solana", "40"), spend("monad", "10")];
    expect(
      largestShortfall(
        legs,
        new Map([
          ["solana", 3_500n],
          ["monad", 0n],
        ]),
      ),
    ).toEqual({ chain: "monad", needUsd: "10.00" });
    expect(
      largestShortfall(
        legs,
        new Map([
          ["solana", 4_000n],
          ["monad", 1_000n],
        ]),
      ),
    ).toBeNull();
  });

  it("claims no shortfall on a chain whose balance couldn't be read", () => {
    expect(largestShortfall([spend("base", "5")], new Map())).toBeNull();
  });

  it("counts the cash the plan's own moves bring before its picks spend it", () => {
    // Savings come out onto Monad, part of it moves on to Solana (landing a dollar less, for
    // the bridge's fee), and the picks spend both.
    const legs = [
      { draws: null, lands: "monad" as const, amountUsd: "12.03" },
      { draws: "monad" as const, lands: "solana" as const, amountUsd: "4.80" },
      spend("monad", "7.00"),
      spend("solana", "5.50"),
    ];
    const held = new Map([
      ["monad", 0n],
      ["solana", 177n],
    ] as const);
    expect(largestShortfall(legs, held)).toBeNull();
    expect(largestShortfall(legs.slice(1), held)).toEqual({ chain: "monad", needUsd: "11.80" });
  });

  it("counts a bridge as landing what its card says it lands at least", () => {
    // The live plan of 2026-11-13: $1.33 on Monad, $2 bridged in from Polygon, a $3 buy. Its
    // card says at least $1.94 lands, so Monad has $3.27 for $3. Counting a dollar lost to the
    // bridge's fee, Auni once refused it as $0.67 short.
    const bridge = { draws: "polygon" as const, lands: "monad" as const, amountUsd: "2.00" };
    const held = new Map([
      ["monad", 133n],
      ["polygon", 558n],
    ] as const);
    const plan = (landsAtLeastUsd: string) => [
      { ...bridge, landsAtLeastUsd },
      spend("monad", "3.00"),
    ];
    expect(largestShortfall(plan("1.94"), held)).toBeNull();
    // A card that says less lands is short by exactly that, its USDC counted to the cent below.
    expect(largestShortfall(plan("1.499999"), held)).toEqual({ chain: "monad", needUsd: "0.18" });
    expect(shortfallSaid(plan("1.50"), held)).toBe(
      "Monad holds $1.33 of cash, this card's own moves land at least $1.50 more there (what their cards say, after fees), and it spends $3 there: $0.17 short",
    );
  });

  it("counts the cash a leg's card spends buying a chain's coin for its fee, where it spends it", () => {
    // A $2 bridge from Base whose card buys the coin for Base's fee with $0.25 of Monad's
    // USDC, then a $3 buy on Monad, which holds $1.06: $1.06 + $1.94 covers the buy, but the
    // quarter has left Monad by then, so the buy would fail for funds after the bridge landed.
    const bridge = {
      draws: "base" as const,
      lands: "monad" as const,
      amountUsd: "2.00",
      landsAtLeastUsd: "1.94",
    };
    const held = new Map([
      ["monad", 106n],
      ["base", 558n],
    ] as const);
    const fee = { feeCash: { from: "monad" as const, usd: "0.25" } };
    expect(largestShortfall([bridge, spend("monad", "3.00")], held)).toBeNull();
    const plan = [{ ...bridge, ...fee }, spend("monad", "3.00")];
    expect(largestShortfall(plan, held)).toEqual({ chain: "monad", needUsd: "0.25" });
    expect(shortfallSaid(plan, held)).toBe(
      "Monad holds $1.06 of cash, this card's own moves land at least $1.94 more there (what their cards say, after fees), and it spends $3.25 there: $0.25 short",
    );
    // With the quarter there too, it is covered.
    expect(largestShortfall(plan, new Map([...held, ["monad", 131n]]))).toBeNull();
    // A bridge can't send on the cash its own card spends on its fee.
    const out = { draws: "monad" as const, lands: "base" as const, amountUsd: "1.00", ...fee };
    expect(largestShortfall([out], new Map([["monad", 106n]]))).toEqual({
      chain: "monad",
      needUsd: "0.19",
    });
  });

  it("reads that cash off the card, and none where a coin pays for the coin", () => {
    const details = (token: string) => ({
      feeCoinOn: "base",
      feeCoinFrom: "monad",
      feeCoinToken: token,
      feeCoinAmount: "250000",
      feeCoinUsd: "0.25",
      feeCoinBy: "Relay",
    });
    const row = (token: string, txs: ActionRow["txs"] = []) =>
      stagedLeg({
        id: "bridge",
        tool: "bridge_usdc",
        input: { from_chain: "base", to_chain: "monad", amount: "2" },
        details: details(token),
        amountUsd: "2.00",
        status: "awaiting_permission",
        phase: null,
        txs,
      });
    expect(row(NETWORKS.monad.usdc)).toMatchObject({
      draws: "base",
      lands: "monad",
      feeCash: { from: "monad", usd: "0.25" },
    });
    expect(row("native").feeCash).toBeUndefined();
    // Once the move kept its purchase that cash is spent: Try again counts none of it again.
    const bought = { chain: "monad", hash: "0xbought", setup: true as const, buysFees: "0xorder" };
    expect(row(NETWORKS.monad.usdc, [bought]).feeCash).toBeUndefined();
  });

  // As "buy 1 dollar of palantir" did on a Saturday, from a Solana address holding nothing:
  // Monad's makers take $10 or more, so the buy goes to Solana, and its cash comes from Polygon
  // on the same card. Each card buys the SOL it is short with a dollar of Monad's USDC.
  it("pays a Solana stock buy from the bridge that brings its cash, on one card", () => {
    const solFee = pinnedSol("1000000");
    const row = (id: string, tool: string, input: Record<string, unknown>, details = {}) =>
      stagedLeg({
        id,
        tool,
        input,
        details: { ...solFee, ...details },
        amountUsd: id === "bridge" ? "1.50" : "1.00",
        status: "awaiting_permission",
        phase: null,
      });
    const bridge = row(
      "bridge",
      "bridge_usdc",
      { from_chain: "polygon", to_chain: "solana", amount: "1.50" },
      { getsAtLeast: "1.455" },
    );
    const buy = row(
      "buy",
      "stock_trade",
      { stock: "PLTR", side: "buy", amountUsd: 1 },
      { chain: "solana" },
    );
    const held = new Map([
      ["polygon", 200n],
      ["solana", 0n],
      ["monad", 500n],
    ] as const);
    expect(largestShortfall([bridge, buy], held)).toBeNull();
    // The bridge runs in a stage before the buy, so the SOL it buys is there for the buy too
    // (buyingSolOnce in sol-top-up.ts).
    expect(bridge.stage).toBeLessThan(buy.stage);
    // Alone, the buy says plainly what is short where, for the agent to bring on one card.
    expect(shortfallSaid([buy], held)).toBe(
      "Solana holds $0 of cash, and it spends $1 there: $1 short",
    );
  });

  it("counts a bridge whose card says nothing of it as landing all but the most a bridge may lose", () => {
    // All $30 of Base's cash moves over and lands at least $29.10, so a card has to add $20.90.
    const legs = [
      { draws: "base" as const, lands: "solana" as const, amountUsd: "30" },
      spend("solana", "50"),
    ];
    const held = new Map([
      ["base", 3_000n],
      ["solana", 0n],
    ] as const);
    expect(largestShortfall(legs, held)).toEqual({ chain: "solana", needUsd: "20.90" });
  });

  it("asks for Arbitrum cash a deposit into Hyperliquid needs, never Hyperliquid itself", () => {
    const legs = [
      { draws: "arbitrum" as const, lands: "hyperliquid" as const, amountUsd: "18.50" },
      { draws: "hyperliquid" as const, lands: null, amountUsd: "30.00" },
    ];
    expect(largestShortfall(legs, new Map([["arbitrum", 0n]]))).toEqual({
      chain: "arbitrum",
      needUsd: "18.50",
    });
  });
});

// Hyperliquid holds $10 free here.
vi.mock(import("./wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: vi.fn(async () => ({ evm: "0x1", solana: null }) as never),
}));
vi.mock(import("../apps/registry.ts"), async (original) => {
  const registry = await original();
  return {
    ...registry,
    ledgerAt: (place: string) => {
      const found = registry.ledgerAt(place);
      const cash = found?.account.cash;
      if (!found || cash?.kind !== "ledger") return found;
      return {
        ...found,
        account: { ...found.account, cash: { ...cash, free: async () => 1_000n } },
      };
    },
  };
});

describe("a plan paid from Hyperliquid", () => {
  it("fits its withdrawals to what Hyperliquid holds now, since they run before any deposit lands", async () => {
    const withdraw = { draws: "hyperliquid" as const, lands: "arbitrum" as const, amountUsd: "8" };
    const deposit = { draws: "arbitrum" as const, lands: "hyperliquid" as const, amountUsd: "6" };
    expect(await uncoveredAccounts([withdraw, withdraw, deposit])).toEqual({
      place: "hyperliquid",
      holdsUsd: "10.00",
      shortUsd: "6.00",
    });
    expect(await uncoveredAccounts([withdraw, deposit])).toBeNull();
  });

  const route = [
    { draws: "hyperliquid" as const, lands: "arbitrum" as const, amountUsd: "7.00" },
    { draws: "arbitrum" as const, lands: "monad" as const, amountUsd: "6.00" },
    spend("monad", "5.00"),
  ];

  it("lands a dollar less than it withdraws, which Hyperliquid keeps", () => {
    const held = new Map([
      ["arbitrum", 0n],
      ["monad", 0n],
    ] as const);
    expect(largestShortfall(route, held)).toBeNull();
    const tooLittle = [{ ...route[0]!, amountUsd: "6.50" }, ...route.slice(1)];
    expect(largestShortfall(tooLittle, held)).toEqual({ chain: "arbitrum", needUsd: "0.50" });
  });
});

describe("bridgesFor", () => {
  const short = { chain: "solana" as const, needUsd: "1.00" };

  it("bridges from the chain with the most to spare, enough over the gap that the least it lands covers it", () => {
    const held = new Map([
      ["solana", 0n],
      ["base", 500n],
      ["monad", 3_890n],
    ] as const);
    // $1.04 lands at least $1.00 (all but 3%).
    expect(bridgesFor(short, [spend("solana", "1")], held)).toEqual([
      { from: "monad", usd: "1.04" },
    ]);
  });

  it("leaves what the plan itself spends on the other chain", () => {
    const held = new Map([
      ["solana", 0n],
      ["monad", 1_200n],
    ] as const);
    expect(bridgesFor(short, [spend("solana", "1"), spend("monad", "12")], held)).toBeNull();
    expect(bridgesFor(short, [spend("solana", "1"), spend("monad", "10")], held)).toEqual([
      { from: "monad", usd: "1.04" },
    ]);
  });

  it("combines chains when no one of them covers it, each paying its own fee", () => {
    const held = new Map([
      ["solana", 0n],
      ["base", 3_000n],
      ["monad", 3_100n],
    ] as const);
    // Monad's $31 lands at least $30.07; Base sends $20.55 for the other $19.93.
    expect(bridgesFor({ chain: "solana", needUsd: "50.00" }, [], held)).toEqual([
      { from: "monad", usd: "31.00" },
      { from: "base", usd: "20.55" },
    ]);
  });

  it("brings what the account has even when it falls short, leaving the rest to a card", () => {
    const held = new Map([
      ["solana", 0n],
      ["base", 3_000n],
    ] as const);
    expect(bridgesFor({ chain: "solana", needUsd: "50.00" }, [], held)).toEqual([
      { from: "base", usd: "30.00" },
    ]);
  });

  it("finds nothing when no other chain has cash to spare", () => {
    const held = new Map([
      ["solana", 0n],
      ["base", 0n],
    ] as const);
    expect(bridgesFor(short, [spend("solana", "1")], held)).toBeNull();
  });

  it("sends a large bridge 3% over, the most its card lets it lose", () => {
    const held = new Map([
      ["solana", 0n],
      ["monad", 1_000_000n],
    ] as const);
    // $1,030.93 lands at least $1,000.00.
    expect(bridgesFor({ chain: "solana", needUsd: "1000.00" }, [], held)).toEqual([
      { from: "monad", usd: "1030.93" },
    ]);
  });

  it("never sends on cash another bridge on the card is still bringing", () => {
    const held = new Map([
      ["solana", 0n],
      ["base", 0n],
      ["monad", 600n],
    ] as const);
    const toBase = { draws: "monad" as const, lands: "base" as const, amountUsd: "6" };
    expect(bridgesFor(short, [toBase, spend("solana", "1")], held)).toBeNull();
  });

  it("brings cash home from Solana too, such as what a stock sale left there", () => {
    const held = new Map([
      ["monad", 0n],
      ["solana", 5_000n],
    ] as const);
    // A dollar more from Solana, which a little of buys the SOL its network charges.
    expect(bridgesFor({ chain: "monad", needUsd: "1.00" }, [spend("monad", "1")], held)).toEqual([
      { from: "solana", usd: "2.04" },
    ]);
  });
});

describe("idleBridges", () => {
  it("finds a bridge out of a wallet holding nothing, and keeps one with cash to send", () => {
    const legs = [
      { draws: "base" as const, lands: "arbitrum" as const, amountUsd: "16" },
      { draws: "monad" as const, lands: "solana" as const, amountUsd: "10" },
      { draws: "arbitrum" as const, lands: "hyperliquid" as const, amountUsd: "15.50" },
      { draws: "hyperliquid" as const, lands: null, amountUsd: "15" },
    ];
    const held = new Map([
      ["base", 0n],
      ["monad", 400n],
      ["arbitrum", 0n],
    ] as const);
    expect(idleBridges(legs, held)).toEqual([0]);
  });

  it("counts savings a withdrawal lands before the bridge sends them on", () => {
    const legs = [
      { draws: null, lands: "monad" as const, amountUsd: "12" },
      { draws: "monad" as const, lands: "solana" as const, amountUsd: "12" },
    ];
    expect(idleBridges(legs, new Map([["monad", 0n]]))).toEqual([]);
  });

  it("counts Hyperliquid cash a withdrawal lands, less its fee, before the bridge sends it on", () => {
    const legs = [
      { draws: "hyperliquid" as const, lands: "arbitrum" as const, amountUsd: "7" },
      { draws: "arbitrum" as const, lands: "monad" as const, amountUsd: "6" },
    ];
    expect(idleBridges(legs, new Map([["arbitrum", 0n]]))).toEqual([]);
  });

  it("keeps a bridge from a wallet that couldn't be read", () => {
    const legs = [{ draws: "base" as const, lands: "solana" as const, amountUsd: "5" }];
    expect(idleBridges(legs, new Map())).toEqual([]);
  });
});

describe("a card of sells and closes", () => {
  const recorded = (tool: string, input: Record<string, unknown>, details: object) =>
    stagedLeg({
      id: tool,
      tool,
      input,
      details: details as Record<string, string>,
      amountUsd: "0",
      status: "awaiting_permission",
      phase: null,
    });
  const legs = [
    recorded(
      "hyperliquid_close",
      { market: "xyz:META", percent: 100, slippagePercent: 1 },
      { market: "xyz:META", returnsUsd: "41.20" },
    ),
    recorded(
      "stock_trade",
      { stock: "NVDA", side: "sell", shares: 1 },
      { chain: "solana", returnsUsd: "180.00" },
    ),
  ];

  it("spends no cash, so it is never short, whatever comes back", () => {
    expect(legs.map(({ draws, amountUsd }) => ({ draws, amountUsd }))).toEqual([
      { draws: null, amountUsd: "0" },
      { draws: null, amountUsd: "0" },
    ]);
    expect(largestShortfall(legs, new Map([["solana", 0n]]))).toBeNull();
  });

  it("needs no margin on Hyperliquid to close a position there", async () => {
    expect(await uncoveredAccounts(legs)).toBeNull();
  });
});

describe("spendsAsChainCash", () => {
  it("counts wallet USDC, and Polymarket's collateral as the Polygon cash a buy there spends", () => {
    expect(spendsAsChainCash({ venue: "wallet", chain: "base", cash: true })).toBe(true);
    expect(spendsAsChainCash({ venue: "polymarket", chain: "polygon", cash: true })).toBe(true);
  });

  it("leaves out tokens, positions, savings and Hyperliquid's account", () => {
    expect(spendsAsChainCash({ venue: "wallet", chain: "base", cash: false })).toBe(false);
    expect(spendsAsChainCash({ venue: "polymarket", chain: "polygon", cash: false })).toBe(false);
    expect(spendsAsChainCash({ venue: "aave", chain: "monad", cash: true })).toBe(false);
    expect(spendsAsChainCash({ venue: "hyperliquid", chain: "hyperliquid", cash: true })).toBe(
      false,
    );
  });
});
