import { CARD_FORMAT } from "@auni/shared";
import { describe, expect, it } from "vitest";

import {
  awaitedCash,
  legsToRetry,
  nextStep,
  PICKS,
  stagedLeg,
  type RetryLeg,
  type StagedLeg,
} from "./proposal-order.ts";
import { pinnedSol } from "../test/sol.ts";

type Row = Parameters<typeof stagedLeg>[0];

function row(id: string, tool: string, input: Record<string, unknown>, amountUsd: string): Row {
  return {
    id,
    tool,
    input,
    amountUsd,
    status: "running",
    phase: "queued",
    // The chain a stock trade's preview chose.
    details: tool === "stock_trade" ? { chain: "solana" } : {},
  };
}

// The founder's plan: savings out on Monad, cash on to Solana, then picks on both.
const savings = row("savings", "aave_withdraw", { chain: "monad", amount_usd: "11.03" }, "11.03");
const bridge = row(
  "bridge",
  "bridge_usdc",
  { from_chain: "monad", to_chain: "solana", amount: "3.80" },
  "3.80",
);
const ether = row(
  "ether",
  "evm_swap",
  { chain: "monad", sellToken: "USDC", buyToken: "WETH", amountUsd: 5.5 },
  "5.50",
);
const sol = row("sol", "solana_swap", { token: "SOL", side: "buy", amountUsd: 5.5 }, "5.50");
const circle = row("circle", "stock_trade", { stock: "CRCL", side: "buy", amountUsd: 4.6 }, "4.60");
const plan = [savings, bridge, ether, sol, circle];

function legs(rows: readonly Row[], changes: Record<string, Partial<StagedLeg>> = {}) {
  return rows.map((each) => ({ ...stagedLeg(each), ...changes[each.id] }));
}

const done = (...ids: string[]) =>
  Object.fromEntries(ids.map((id) => [id, { status: "done" as const, queued: false }]));

describe("stagedLeg", () => {
  // Two bridges into Solana side by side and a buy there: the one buying SOL for all three runs
  // before the other, so the SOL is there for it (buyingSolOnce in sol-top-up.ts).
  it("runs a move buying its card's SOL ahead of the moves beside it", () => {
    const into = (id: string, from: string, details: Record<string, string> = {}) => ({
      ...row(id, "bridge_usdc", { from_chain: from, to_chain: "solana", amount: "1" }, "1.00"),
      details,
    });
    const fromBase = into("base", "base");
    const fromArbitrum = into("arbitrum", "arbitrum", {
      ...pinnedSol("1000000"),
      feeCoinAhead: "yes",
    });
    const buy = row("buy", "stock_trade", { stock: "PLTR", side: "buy", amountUsd: 1 }, "1.00");
    const card = legs([fromBase, fromArbitrum, buy]);
    expect(nextStep(card)).toEqual({ kind: "start", stage: 0.5, ids: ["arbitrum"] });
    expect(nextStep(legs([fromBase, fromArbitrum, buy], done("arbitrum")))).toMatchObject({
      ids: ["base"],
    });
  });

  it("runs savings out first, cash between wallets next, and every pick last", () => {
    expect(stagedLeg(savings)).toMatchObject({ stage: 0, lands: "monad", draws: null });
    expect(stagedLeg(bridge)).toMatchObject({ stage: 1, lands: "solana", draws: "monad" });
    expect(stagedLeg(ether)).toMatchObject({ stage: PICKS, lands: null, draws: "monad" });
    expect(stagedLeg(sol)).toMatchObject({ stage: PICKS, draws: "solana" });
    expect(stagedLeg(circle)).toMatchObject({ stage: PICKS, draws: "solana" });
  });

  it("moves cash into Hyperliquid after it reaches Arbitrum, and perps spend it from there", () => {
    const toArbitrum = row(
      "arb",
      "bridge_usdc",
      { from_chain: "monad", to_chain: "arbitrum", amount: "19" },
      "19.00",
    );
    const deposit = row("deposit", "hyperliquid_deposit", { amountUsd: 18.5 }, "18.50");
    const perp = row(
      "perp",
      "hyperliquid_order",
      { market: "xyz:RKLB", side: "long", sizeUsd: 18, leverage: 1 },
      "18.00",
    );
    const staged = legs([toArbitrum, deposit, perp]);
    expect(staged.map((leg) => leg.stage)).toEqual([1, 2, PICKS]);
    expect(staged[1]).toMatchObject({ lands: "hyperliquid", draws: "arbitrum" });
    expect(staged[2]).toMatchObject({ lands: null, draws: "hyperliquid" });
    expect(nextStep(staged)).toEqual({ kind: "start", stage: 1, ids: ["arb"] });
    const bridged = legs([toArbitrum, deposit, perp], done("arb"));
    expect(nextStep(bridged)).toEqual({ kind: "start", stage: 2, ids: ["deposit"] });
    expect(awaitedCash(bridged, 2)).toEqual(new Map([["arbitrum", 1850n]]));
    const deposited = legs([toArbitrum, deposit, perp], done("arb", "deposit"));
    expect(awaitedCash(deposited, PICKS)).toEqual(new Map([["hyperliquid", 1800n]]));
  });

  it("takes Hyperliquid's free cash out first, then on to Monad, then buys", () => {
    const withdraw = row("withdraw", "hyperliquid_withdraw", { amountUsd: 7 }, "7.00");
    const toMonad = row(
      "monad",
      "bridge_usdc",
      { from_chain: "arbitrum", to_chain: "monad", amount: "6" },
      "6.00",
    );
    const nvidia = row(
      "nvidia",
      "stock_trade",
      { stock: "NVDA", side: "buy", amountUsd: 5 },
      "5.00",
    );
    const route = [withdraw, toMonad, { ...nvidia, details: { chain: "monad" } }];
    expect(legs(route).map((leg) => [leg.stage, leg.draws, leg.lands])).toEqual([
      [0, "hyperliquid", "arbitrum"],
      [1, "arbitrum", "monad"],
      [PICKS, "monad", null],
    ]);
    expect(nextStep(legs(route))).toEqual({ kind: "start", stage: 0, ids: ["withdraw"] });
    expect(awaitedCash(legs(route, done("withdraw")), 1)).toEqual(new Map([["arbitrum", 600n]]));
    expect(nextStep(legs(route, { withdraw: { status: "failed", queued: false } }))).toEqual({
      kind: "stop",
      ids: ["monad", "nvidia"],
    });
  });

  it("holds a Polymarket buy until cash bridged to Polygon lands; a sale spends none", () => {
    const toPolygon = row(
      "polygon",
      "bridge_usdc",
      { from_chain: "monad", to_chain: "polygon", amount: "6" },
      "6.00",
    );
    const market = { market: "will-it-rain", outcome: "Yes" };
    const buy = row("buy", "polymarket_order", { ...market, side: "buy", amountUsd: 5 }, "5.11");
    const sale = row("sale", "polymarket_order", { ...market, side: "sell" }, "0");
    expect(stagedLeg(buy)).toMatchObject({ stage: PICKS, draws: "polygon" });
    expect(stagedLeg(sale)).toMatchObject({ stage: PICKS, draws: null });
    expect(awaitedCash(legs([toPolygon, buy], done("polygon")), PICKS)).toEqual(
      new Map([["polygon", 511n]]),
    );
  });

  it("keeps a bridge that swaps into a token on arrival a pick: it buys something", () => {
    const buys = row(
      "buys",
      "bridge_usdc",
      {
        from_chain: "monad",
        to_chain: "base",
        amount: "5",
        output_token: "0x4200000000000000000000000000000000000006",
      },
      "5.00",
    );
    expect(stagedLeg(buys).stage).toBe(PICKS);
  });
});

describe("nextStep", () => {
  it("starts only the savings on the tap", () => {
    expect(nextStep(legs(plan))).toEqual({ kind: "start", stage: 0, ids: ["savings"] });
  });

  it("waits while a move is still running, then starts the next stage", () => {
    expect(nextStep(legs(plan, { savings: { queued: false } }))).toEqual({ kind: "none" });
    expect(nextStep(legs(plan, done("savings")))).toEqual({
      kind: "start",
      stage: 1,
      ids: ["bridge"],
    });
    expect(nextStep(legs(plan, done("savings", "bridge")))).toEqual({
      kind: "start",
      stage: PICKS,
      ids: ["ether", "sol", "circle"],
    });
  });

  it("stops only the picks a failed move was to pay for, down the chain, and starts the rest", () => {
    const bridgeFailed = legs(plan, {
      ...done("savings"),
      bridge: { status: "failed", queued: false },
    });
    expect(nextStep(bridgeFailed)).toEqual({ kind: "stop", ids: ["sol", "circle"] });
    // Once they're stopped, the pick on Monad, which the savings paid for, still runs.
    const solanaStopped = bridgeFailed.map((leg) =>
      leg.draws === "solana" ? { ...leg, status: "failed" as const, queued: false } : leg,
    );
    expect(nextStep(solanaStopped)).toEqual({ kind: "start", stage: PICKS, ids: ["ether"] });
    expect(nextStep(legs(plan, { savings: { status: "failed", queued: false } }))).toEqual({
      kind: "stop",
      ids: ["bridge", "ether", "sol", "circle"],
    });
  });

  // Oct 30: of three moves out of Base, the one to Solana failed while the others were still on
  // their way, and it stopped every pick, the ones on Monad and Polygon too.
  it("still buys with the money that moved when another move failed", () => {
    const from = (to: string, amount: string) =>
      row(to, "bridge_usdc", { from_chain: "base", to_chain: to, amount }, amount);
    const card = [
      from("polygon", "22.11"),
      from("monad", "25.00"),
      from("solana", "56.00"),
      row("anthropic", "solana_swap", { token: "PRE", side: "buy", amountUsd: 41 }, "41.00"),
      row(
        "ipo",
        "polymarket_order",
        { market: "ipo", outcome: "Yes", side: "buy", amountUsd: 21 },
        "21.00",
      ),
      {
        ...row("amazon", "stock_trade", { stock: "AMZN", side: "buy", amountUsd: 13 }, "13.00"),
        details: { chain: "monad" },
      },
    ];
    const started = { status: "running" as const, queued: false };
    const solanaFailed = legs(card, {
      polygon: started,
      monad: started,
      solana: { status: "failed", queued: false },
    });
    expect(nextStep(solanaFailed)).toEqual({ kind: "stop", ids: ["anthropic"] });
    const stopped = { status: "failed" as const, queued: false };
    expect(
      nextStep(
        legs(card, { polygon: started, monad: started, solana: stopped, anthropic: stopped }),
      ),
    ).toEqual({ kind: "none" });
    expect(
      nextStep(legs(card, { ...done("polygon", "monad"), solana: stopped, anthropic: stopped })),
    ).toEqual({ kind: "start", stage: PICKS, ids: ["ipo", "amazon"] });
  });

  it("stops a leg that spends from nowhere known once any earlier move failed", () => {
    const sale = row(
      "sale",
      "polymarket_order",
      { market: "m", outcome: "Yes", side: "sell" },
      "0",
    );
    expect(
      nextStep(
        legs([savings, bridge, sale], {
          ...done("savings"),
          bridge: { status: "failed", queued: false },
        }),
      ),
    ).toEqual({ kind: "stop", ids: ["sale"] });
  });

  it("starts a plan without money moves all at once, as before", () => {
    expect(nextStep(legs([sol, circle]))).toEqual({
      kind: "start",
      stage: PICKS,
      ids: ["sol", "circle"],
    });
  });

  it("has nothing to do once every leg has started", () => {
    expect(nextStep(legs(plan, done("savings", "bridge", "ether", "sol", "circle")))).toEqual({
      kind: "none",
    });
  });
});

describe("a card paying with a holding", () => {
  // ETH that came in on Base converts to USDC there, which moves on to Monad for the pick.
  const convert = row(
    "convert",
    "convert_to_cash",
    { chain: "base", token: "native", amount: "0.034" },
    "99.12",
  );
  const onward = row(
    "onward",
    "bridge_usdc",
    { from_chain: "base", to_chain: "monad", amount: "99.12" },
    "99.12",
  );
  const paid = [convert, onward, ether];

  it("converts first, as savings come out, then moves the cash, then buys", () => {
    expect(stagedLeg(convert)).toMatchObject({ stage: 0, lands: "base", draws: null });
    expect(nextStep(legs(paid))).toEqual({ kind: "start", stage: 0, ids: ["convert"] });
    expect(nextStep(legs(paid, done("convert")))).toEqual({
      kind: "start",
      stage: 1,
      ids: ["onward"],
    });
  });

  it("buys nothing when the conversion fails, so the money stays the token", () => {
    expect(nextStep(legs(paid, { convert: { status: "failed", queued: false } }))).toEqual({
      kind: "stop",
      ids: ["onward", "ether"],
    });
  });

  it("buys nothing when the cash it made can't move on, so it stays USDC where it was made", () => {
    expect(
      nextStep(legs(paid, { ...done("convert"), onward: { status: "failed", queued: false } })),
    ).toEqual({ kind: "stop", ids: ["ether"] });
  });

  it("waits for the converted cash to be there before the bridge sends it", () => {
    expect(awaitedCash(legs(paid, done("convert")), 1)).toEqual(new Map([["base", 9_912n]]));
  });
});

describe("awaitedCash", () => {
  it("awaits what the picks spend from wallets the moves landed cash in", () => {
    expect(awaitedCash(legs(plan, done("savings", "bridge")), PICKS)).toEqual(
      new Map([
        ["monad", 550n],
        ["solana", 1_010n],
      ]),
    );
  });

  it("awaits nothing a move didn't land, or a plan that moved nothing", () => {
    expect(awaitedCash(legs([sol, circle]), PICKS)).toEqual(new Map());
    expect(awaitedCash(legs([bridge, ether], done("bridge")), PICKS)).toEqual(new Map());
  });
});

describe("legsToRetry", () => {
  const as = (
    each: Row,
    status: RetryLeg["status"],
    failureKind: RetryLeg["failureKind"] = null,
  ): RetryLeg => ({ ...each, status, failureKind, txs: [], cardFormat: CARD_FORMAT });
  const retried = (rows: readonly RetryLeg[], pricedPast: readonly string[] = []) =>
    legsToRetry(rows, new Set(pricedPast));

  it("runs a move that blipped again with every pick it stopped", () => {
    expect(
      retried([
        as(savings, "done"),
        as(bridge, "failed", "glitch"),
        as(ether, "failed", "stopped"),
        as(sol, "failed", "stopped"),
      ]),
    ).toEqual(["bridge", "ether", "sol"]);
  });

  it("runs only the picks that blipped, leaving the one short of money", () => {
    expect(
      retried([as(ether, "failed", "busy"), as(sol, "failed", "funds"), as(circle, "done")]),
    ).toEqual(["ether"]);
  });

  it("leaves picks stopped behind a move that can't go again, which would only stop them again", () => {
    expect(
      retried([
        as(savings, "failed", "glitch"),
        as(bridge, "failed", "funds"),
        as(ether, "failed", "stopped"),
        as(sol, "failed", "stopped"),
      ]),
    ).toEqual(["savings", "ether"]);
    expect(retried([as(bridge, "failed", "rule"), as(ether, "failed", "stopped")])).toBeNull();
  });

  it("runs nothing when a leg it would run was drawn before cards said all they say now", () => {
    expect(
      retried([
        { ...as(bridge, "failed", "glitch"), cardFormat: CARD_FORMAT - 1 },
        as(ether, "failed", "stopped"),
      ]),
    ).toBeNull();
  });

  it("runs nothing while a leg still runs, or once something went out", () => {
    expect(retried([as(ether, "failed", "glitch"), as(sol, "running")])).toBeNull();
    expect(
      retried([{ ...as(ether, "failed", "glitch"), txs: [{ chain: "monad", hash: "0x1" }] }]),
    ).toBeNull();
  });

  it("runs a pick again with the move that was to pay for it, whatever else can't go again", () => {
    const toPolygon = row(
      "polygon",
      "bridge_usdc",
      { from_chain: "base", to_chain: "polygon", amount: "22" },
      "22.00",
    );
    const bet = row(
      "bet",
      "polymarket_order",
      { market: "ipo", outcome: "Yes", side: "buy", amountUsd: 21 },
      "21.00",
    );
    expect(
      retried([
        as(bridge, "failed", "glitch"),
        as(toPolygon, "failed", "funds"),
        as(sol, "failed", "stopped"),
        as(bet, "failed", "stopped"),
      ]),
    ).toEqual(["bridge", "sol"]);
  });

  // Its card offers it again only back inside what was approved, so one tap runs nothing else.
  it("leaves a leg whose price is past what was approved now, with the picks behind it", () => {
    const legs = [
      as(savings, "failed", "glitch"),
      as(bridge, "failed", "price"),
      as(ether, "failed", "stopped"),
      as(sol, "failed", "stopped"),
    ];
    expect(retried(legs, ["bridge"])).toEqual(["savings", "ether"]);
    expect(retried(legs)).toEqual(["savings", "bridge", "ether", "sol"]);
  });

  // That code vouched for the card as it ran then; a tap can't stand in for a fresh one.
  it("runs nothing when a leg it would free needs the owner's proof", () => {
    expect(
      retried([
        as(bridge, "failed", "glitch"),
        { ...as(ether, "failed", "stopped"), details: { leavesTo: "0xabc" } },
      ]),
    ).toBeNull();
  });

  it("runs a move again whose only send was its setup", () => {
    expect(
      retried([
        { ...as(ether, "failed", "price"), txs: [{ chain: "monad", hash: "0x1", setup: true }] },
      ]),
    ).toEqual(["ether"]);
  });
});
