import { randomUUID } from "node:crypto";

import { activityWireSchema, NETWORKS } from "@auni/shared";

import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, arrivals, specialists, fills } from "../db/schema.ts";
import { insertAction, insertSpecialist, setOwner, wipe } from "../test/db.ts";
import { FACE } from "../test/recipe.ts";
import { serve } from "../test/serve.ts";
import { activityRouter } from "./routes.ts";

// No stock catalog to read: every name here is a coin or a Hyperliquid ticker.
vi.mock("./swaps/xstocks.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  xStockCatalog: async () => [],
}));
// The token lists, stood in for: CoinGecko's lists Tether Gold on Monad, as the live one does.
const TETHER_GOLD = "0x01bff41798a0bcf287b996046ca68b395dbc1071";
vi.mock("./recognised.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listings: async (chain: string, instruments: readonly string[]) =>
    new Map(
      instruments.map((instrument) => [
        `${chain}:${instrument}`.toLowerCase(),
        instrument.toLowerCase() === TETHER_GOLD
          ? { recognised: true, symbol: "XAUt0", name: "Tether Gold Tokens" }
          : { recognised: false, symbol: null, name: null },
      ]),
    ),
}));

const url = serve(express().use("/activity", activityRouter));

const ADDRESS = "0x00000000000000000000000000000000000a0b1c";
const started = new Date("2026-10-20T08:30:00Z");

beforeEach(async () => {
  await wipe(specialists, actions, fills, arrivals);
});

async function activity(query = "") {
  const response = await fetch(url(`/activity${query}`));
  return { status: response.status, body: (await response.json()) as unknown };
}

/** The Pearl card, as it ran: two holdings sold, cash bridged and moved in, Pearl opened. */
async function pearlCard(specialistId: string) {
  const proposalId = randomUUID();
  const leg = (fields: Partial<typeof actions.$inferInsert>) =>
    insertAction({
      proposalId,
      specialistId,
      status: "done",
      startedAt: started,
      // Each run ended seconds after it started, once what it traded was recorded.
      endedAt: new Date(started.getTime() + 5_000),
      ...fields,
    });
  await leg({
    tool: "convert_to_cash",
    specialistId: null,
    input: { chain: "solana", token: "native", amount: "0.025" },
    details: { chain: "solana", mint: "native", token: "SOL" },
    run: { returnedUsd: "4.30" },
    amountUsd: "4.20",
  });
  await leg({
    tool: "convert_to_cash",
    specialistId: null,
    input: { chain: "base", token: "native", amount: "0.0017" },
    details: { chain: "base", mint: "native", token: "ETH" },
    run: { returnedUsd: "4.50" },
    amountUsd: "4.40",
  });
  await leg({
    tool: "bridge_usdc",
    specialistId: null,
    input: { from_chain: "base", to_chain: "arbitrum", amount: "17" },
    amountUsd: "17.00",
  });
  await leg({ tool: "hyperliquid_deposit", input: { amount: 17 }, amountUsd: "17.00" });
  const open = await leg({
    tool: "hyperliquid_order",
    venue: "hyperliquid",
    input: { market: "io:PRL", side: "long", leverage: 1, sizeUsd: 16.5 },
    details: { market: "io:PRL" },
    amountUsd: "16.50",
  });
  await db.insert(fills).values([
    {
      actionId: open.id,
      specialistId,
      chain: "hyperliquid",
      instrument: "io:PRL",
      side: "buy",
      quantity: "41",
      usdValue: "16.50",
      venueRef: `hyperliquid:${ADDRESS}:11`,
      createdAt: new Date(started.getTime() + 2_000),
    },
    // Its stop went off two days later.
    {
      actionId: open.id,
      specialistId,
      chain: "hyperliquid",
      instrument: "io:PRL",
      side: "sell",
      quantity: "41",
      usdValue: "14.10",
      pnlUsd: "-2.404",
      venueRef: `hyperliquid:${ADDRESS}:12`,
      createdAt: new Date("2026-10-22T03:00:00Z"),
    },
  ]);
  return proposalId;
}

/** On Oct 14 Hyperliquid liquidated Starknet's STRK long, recorded once Auni read it. */
async function strkLiquidation(specialistId: string) {
  const liquidated = await insertAction({
    tool: "hyperliquid_venue_fill",
    venue: "hyperliquid",
    status: "done",
    summary: "Hyperliquid liquidated the STRK long: 193.1 sold at $0.07855, losing $5.26",
    amountUsd: "0",
    details: {
      cause: "liquidation",
      market: "STRK",
      side: "sell",
      size: "193.1",
      priceUsd: "0.07855",
      before: "193.1",
      after: "0",
      closedPnlUsd: "-5.256182",
      venueFeeUsd: "0.006825",
    },
    createdAt: new Date("2026-10-14T09:21:00Z"),
  });
  await db.insert(fills).values({
    actionId: liquidated.id,
    specialistId,
    chain: "hyperliquid",
    instrument: "STRK",
    side: "sell",
    quantity: "193.1",
    usdValue: "15.16",
    venueRef: `hyperliquid:${ADDRESS}:498999898257703`,
    createdAt: new Date("2026-10-14T09:21:00Z"),
  });
  return liquidated;
}

describe("GET /activity", () => {
  it("lists what happened to their money, one item each, the venue's and money in unread", async () => {
    // In Sydney, and they last looked before any of it was recorded.
    await setOwner({
      timeZone: "Australia/Sydney",
      activitySeenAt: new Date("2026-10-01T00:00:00Z"),
    });
    const starknet = await insertSpecialist({ name: "Starknet" });
    const pearl = await insertSpecialist({ name: "Pearl bet" });
    const proposalId = await pearlCard(pearl.id);
    const liquidated = await strkLiquidation(starknet.id);
    await db.insert(arrivals).values({
      chain: "base",
      txHash: "0xdeposit",
      position: "log:1",
      instrument: NETWORKS.base.usdc,
      baseUnits: "250000000",
      decimals: 6,
      usdValue: "250.00",
      counterparty: "0x2222222222222222222222222222222222222222",
      kind: "deposit",
      at: new Date(Date.now() - 60_000),
      block: 1,
    });

    const { status, body } = await activity();
    expect(status).toBe(200);
    const read = activityWireSchema.parse(body);
    expect(read.unread).toBe(2);
    expect(read.items.map((item) => [item.kind, item.title, item.unread])).toEqual([
      ["arrival", "Money arrived", true],
      ["move", "Closed your PRL long", false],
      ["move", "Started Pearl bet", false],
      ["outside", "Hyperliquid closed your STRK long", true],
    ]);
    const [, stop, card, outside] = read.items;
    expect(card).toMatchObject({
      id: proposalId,
      specialistId: pearl.id,
      subtitle: "Pearl bet, Oct 20 at 7:30pm",
      amount: { usd: "16.50", direction: null, tone: "neutral" },
      receipt: {
        steps: [
          { text: "Sold 2 things you held loose", amountUsd: "8.80" },
          { text: "Moved cash to Hyperliquid", amountUsd: "17.00" },
          { text: "Opened PRL, 1x long", amountUsd: "16.50" },
        ],
      },
    });
    // What it sold at isn't what came back: the fills don't say, so it shows no amount. What the
    // venue said it locked in is its story.
    expect(stop).toMatchObject({
      amount: null,
      receipt: {
        steps: [{ text: "It reached a stop-loss or take-profit price Auni set.", amountUsd: null }],
        story: {
          gave: { label: "Your 1x long", value: "$14.10" },
          got: { label: "It lost", value: "$2.40", tone: "loss" },
          levels: [{ label: "Closed at", price: "$0.3439", kind: "price" }],
          facts: [{ label: "Through", value: "Hyperliquid" }],
        },
      },
    });
    expect(outside).toMatchObject({
      id: liquidated.id,
      specialistId: starknet.id,
      subtitle: "Starknet, Oct 14 at 8:21pm",
      amount: { usd: "5.26", direction: "out", tone: "loss" },
      decision: true,
      receipt: {
        by: "Hyperliquid",
        before: "193.1 STRK long, worth $15.17",
        after: "Closed",
        why: "Its price moved against it until the margin behind it ran out.",
      },
    });

    const starknets = activityWireSchema.parse((await activity(`?specialist=${starknet.id}`)).body);
    expect(starknets.items.map((item) => item.id)).toEqual([liquidated.id]);

    expect((await fetch(url("/activity/seen"), { method: "POST" })).status).toBe(204);
    expect(activityWireSchema.parse((await activity()).body).unread).toBe(0);
  });

  it("says a limit was placed until it fills, then what it put in", async () => {
    const specialist = await insertSpecialist({ name: "Rally" });
    const limit = await insertAction({
      specialistId: specialist.id,
      status: "done",
      startedAt: started,
      tool: "hyperliquid_order",
      venue: "hyperliquid",
      input: { market: "ETH", side: "long", leverage: 3, sizeUsd: 150, orderType: "limit" },
      details: { market: "ETH" },
      amountUsd: "50.00",
    });
    const items = () => activity().then(({ body }) => activityWireSchema.parse(body).items);

    expect(await items()).toEqual([
      expect.objectContaining({
        title: "Placed an order for ETH",
        amount: null,
        receipt: expect.objectContaining({
          steps: [
            expect.objectContaining({
              text: "Placed an order to open ETH, 3x long",
              amountUsd: null,
            }),
          ],
        }),
      }),
    ]);

    // Two days later it filled: $150 of ETH at 3x is $50 of theirs.
    await db.insert(fills).values({
      actionId: limit.id,
      specialistId: specialist.id,
      chain: "hyperliquid",
      instrument: "ETH",
      side: "buy",
      quantity: "0.05",
      usdValue: "150.00",
      venueRef: `hyperliquid:${ADDRESS}:51`,
      createdAt: new Date("2026-10-22T03:00:00Z"),
    });
    expect((await items()).map(({ title, amount }) => [title, amount])).toEqual([
      ["Started Rally", { usd: "50.00", direction: null, tone: "neutral" }],
      ["Placed an order for ETH", null],
    ]);
  });

  // Real use read "Bought Monad $0.02" for a wrap, "Bought BTC $3.50" for a long and "Closed BTC
  // $3.46" for its close, and a Polymarket buy at the most it could cost.
  it("says what each move did, and what a buy really spent", async () => {
    const done = (fields: Partial<typeof actions.$inferInsert>) =>
      insertAction({ status: "done", startedAt: started, ...fields });
    const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
    await done({
      tool: "send_evm_transaction",
      input: { chain: "monad" },
      details: {
        network: "Monad",
        sendsUpTo: `0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE:${10n ** 18n}`,
        getsAbout: `${WMON}:${10n ** 18n}`,
        chain: "monad",
        mint: WMON,
        token: "WMON",
      },
      amountUsd: "0.02",
    });
    const long = await done({
      tool: "hyperliquid_order",
      venue: "hyperliquid",
      input: { market: "BTC", side: "long", leverage: 3, sizeUsd: 10.4 },
      details: { market: "BTC" },
      amountUsd: "3.50",
    });
    await db.insert(fills).values({
      actionId: long.id,
      chain: "hyperliquid",
      instrument: "BTC",
      side: "buy",
      quantity: "0.0001",
      usdValue: "10.40",
    });
    // Read "Opened a ETH short" too: the article goes with the name it comes before.
    const short = await done({
      tool: "hyperliquid_order",
      venue: "hyperliquid",
      input: { market: "ETH", side: "short", leverage: 2, sizeUsd: 8 },
      details: { market: "ETH" },
      amountUsd: "4.00",
    });
    await db.insert(fills).values({
      actionId: short.id,
      chain: "hyperliquid",
      instrument: "ETH",
      side: "sell",
      quantity: "0.002",
      usdValue: "8.00",
    });
    await done({
      tool: "hyperliquid_close",
      venue: "hyperliquid",
      input: { market: "BTC", percent: 100 },
      details: {
        market: "BTC",
        side: "long",
        leverage: "3",
        sizeUsd: "10.40",
        pnlUsd: "-0.04",
        returnsUsd: "3.46",
      },
    });
    await done({
      tool: "polymarket_order",
      venue: "polymarket",
      input: { side: "buy" },
      details: {},
      run: { spentUsd: "1.51" },
      amountUsd: "1.58",
    });
    const items = activityWireSchema.parse((await activity()).body).items;
    expect(items.map(({ title, amount }) => [title, amount?.usd ?? null])).toEqual(
      expect.arrayContaining([
        ["Wrapped MON", "0.02"],
        ["Opened a BTC long", "3.50"],
        ["Opened an ETH short", "4.00"],
        ["Closed your BTC long", "3.46"],
        ["Bought prediction shares", "1.51"],
      ]),
    );
  });

  it("tells a move of one step whole: what left and arrived, at what price, through what, and where to see it", async () => {
    const done = (fields: Partial<typeof actions.$inferInsert>) =>
      insertAction({ status: "done", startedAt: started, ...fields });
    const through = "KyberSwap, filled on Kuru";
    const gold = await done({
      tool: "evm_swap",
      venue: "evm-swap",
      input: { chain: "monad", sellToken: "USDC", buyToken: TETHER_GOLD, amountUsd: 3 },
      details: {
        chain: "monad",
        sellToken: NETWORKS.monad.usdc,
        buyToken: TETHER_GOLD,
        mint: TETHER_GOLD,
        token: "XAUt0",
        venue: "KyberSwap",
        sell: "3 USDC",
        estimatedReceive: "0.000776 XAUt0",
        through,
      },
      run: { venue: "KyberSwap", through },
      txs: [{ chain: "monad", hash: "0xb0" }],
      amountUsd: "3.00",
    });
    await db.insert(fills).values({
      actionId: gold.id,
      chain: "monad",
      instrument: TETHER_GOLD,
      side: "buy",
      quantity: "0.000775",
      usdValue: "3.00",
    });
    await done({
      tool: "bridge_usdc",
      venue: "across",
      input: { from_chain: "monad", to_chain: "polygon", amount: "1" },
      run: { lands: "$0.99 on Polygon", delivered: "0xd1" },
      // The approval it needed first is groundwork, not something to look at.
      txs: [
        { chain: "monad", hash: "0xa0", setup: true },
        { chain: "monad", hash: "0xa1" },
      ],
      amountUsd: "1.00",
      startedAt: new Date(started.getTime() + 60_000),
    });

    const [bridge, bought] = activityWireSchema.parse((await activity()).body).items;
    expect(bought).toMatchObject({
      title: "Bought Tether Gold",
      logo: { name: "Tether Gold" },
      receipt: {
        story: {
          gave: { label: "You paid", value: "3 USDC", place: "Monad" },
          got: { label: "You got", value: "0.000775 XAUt0", place: "Monad" },
          levels: [],
          facts: [
            { label: "Price", value: "$3,870.97 per XAUt0" },
            { label: "Through", value: through },
          ],
          links: [{ label: "See it on Monadscan", url: "https://monadscan.com/tx/0xb0" }],
        },
      },
    });
    expect(bridge).toMatchObject({
      title: "Moved cash from Monad to Polygon",
      receipt: {
        story: {
          gave: { label: "Sent", value: "$1", place: "Monad" },
          got: { label: "Arrived", value: "$0.99", place: "Polygon" },
          levels: [],
          facts: [{ label: "Through", value: "Across" }],
          links: [
            { label: "See it on Monadscan", url: "https://monadscan.com/tx/0xa1" },
            { label: "See it arrive on PolygonScan", url: "https://polygonscan.com/tx/0xd1" },
          ],
        },
      },
    });
  });

  // Real use opened "Closed your Tesla short" to "$3.49" and "Through Hyperliquid", and nothing
  // of the position, its prices or what it lost.
  it("tells a position's story: what it opened or closed, its prices and stops, and what it made", async () => {
    const done = (fields: Partial<typeof actions.$inferInsert>, at: number) =>
      insertAction({
        status: "done",
        tool: "hyperliquid_order",
        venue: "hyperliquid",
        startedAt: new Date(started.getTime() + at * 60_000),
        ...fields,
      });
    const filled = (actionId: string, fill: Partial<typeof fills.$inferInsert>) =>
      db.insert(fills).values({
        actionId,
        chain: "hyperliquid",
        instrument: "ETH",
        side: "sell",
        quantity: "0.003",
        usdValue: "10.00",
        ...fill,
      });
    const short = await done(
      {
        input: {
          market: "ETH",
          side: "short",
          leverage: 3,
          sizeUsd: 10,
          stopLoss: 3_600,
          takeProfit: 3_050,
        },
        details: { market: "ETH" },
        amountUsd: "3.33",
      },
      0,
    );
    await filled(short.id, { pnlUsd: "0" });
    await done(
      {
        tool: "hyperliquid_set_stops",
        input: { market: "ETH", stopLoss: 3_500, takeProfit: null },
        details: { market: "ETH", markPx: "3320" },
        amountUsd: "0",
      },
      1,
    );
    const close = await done(
      {
        tool: "hyperliquid_close",
        input: { market: "ETH", percent: 100 },
        details: {
          market: "ETH",
          side: "short",
          leverage: "3",
          sizeUsd: "10.05",
          pnlUsd: "-0.04",
          returnsUsd: "3.29",
          entryPx: "3333.33",
        },
        amountUsd: "0",
      },
      2,
    );
    await filled(close.id, { side: "buy", usdValue: "10.05", pnlUsd: "-0.049995" });

    const stories = activityWireSchema
      .parse((await activity()).body)
      .items.map(({ title, kind, receipt }) => [title, kind === "move" ? receipt.story : null]);
    const through = { label: "Through", value: "Hyperliquid" };
    expect(stories).toEqual([
      [
        "Closed your ETH short",
        {
          gave: { label: "Your 3x short", value: "$10.05", place: null, tone: "neutral" },
          got: { label: "It lost", value: "$0.05", place: null, tone: "loss" },
          // A short loses as the price rises: it closed above where it was entered.
          levels: [
            { label: "Closed at", price: "$3,350.00", kind: "price" },
            { label: "Entered at", price: "$3,333.33", kind: "price" },
          ],
          facts: [through],
          links: [],
        },
      ],
      [
        "Set stops on ETH",
        {
          gave: null,
          got: null,
          levels: [
            { label: "Stop-loss", price: "$3,500.00", kind: "stop" },
            { label: "Price then", price: "$3,320.00", kind: "price" },
          ],
          facts: [{ label: "Take-profit", value: "Removed" }, through],
          links: [],
        },
      ],
      [
        "Opened an ETH short",
        {
          gave: { label: "You put in", value: "$3.33", place: null, tone: "neutral" },
          got: { label: "Your 3x short", value: "$10", place: null, tone: "neutral" },
          levels: [
            { label: "Stop-loss", price: "$3,600.00", kind: "stop" },
            { label: "Entered at", price: "$3,333.33", kind: "price" },
            { label: "Take-profit", price: "$3,050.00", kind: "stop" },
          ],
          facts: [through],
          links: [],
        },
      ],
    ]);
  });

  it("names a bet by its market's question, as its card's row does", async () => {
    await insertAction({
      status: "done",
      startedAt: started,
      tool: "polymarket_order",
      venue: "polymarket",
      input: { market: "will-it-rain", outcome: "Yes", side: "buy", amountUsd: 5 },
      // Its face says how it reads as one row among several: its market, with its side as a tag.
      card: { ...FACE, pick: { name: "Will it rain?", tag: "Yes" } },
      amountUsd: "5.00",
    });
    const { items } = activityWireSchema.parse((await activity()).body);
    expect(items.map(({ title }) => title)).toEqual(["Bought “Will it rain?”"]);
  });

  it("still lists a move on a network Auni no longer offers, as it was told then", async () => {
    // Optimism left Auni's networks after this bridge was recorded by its name.
    await insertAction({
      tool: "bridge_usdc",
      venue: "across",
      status: "done",
      summary: "Move $5 of USDC from Optimism to Base",
      amountUsd: "5.00",
      input: { from_chain: "optimism", to_chain: "base", amount: "5" },
      createdAt: started,
    });
    await insertAction({
      tool: "bridge_usdc",
      venue: "across",
      status: "done",
      summary: "Move $4 of USDC from Base to Optimism",
      amountUsd: "4.00",
      input: { from_chain: "base", to_chain: "optimism", amount: "4" },
      createdAt: started,
    });

    const { status, body } = await activity();
    expect(status).toBe(200);
    expect(
      activityWireSchema
        .parse(body)
        .items.map((item) => item.title)
        .sort(),
    ).toEqual(["Move $4 of USDC from Base to Optimism", "Move $5 of USDC from Optimism to Base"]);
  });

  it("finds no specialist by what isn't an id", async () => {
    expect((await activity("?specialist=not-a-uuid")).status).toBe(404);
  });
});
