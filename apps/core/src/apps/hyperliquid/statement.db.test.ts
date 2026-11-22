import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { db } from "../../db/client.ts";
import { actions, arrivalCursors, specialists, fills, messages, threads } from "../../db/schema.ts";
import { insertAction, insertSpecialist, insertThread, wipe } from "../../test/db.ts";
import { queued } from "../../test/jobs.ts";
import { executeAction } from "../../money/actions.ts";
import type { Recipe } from "../../money/recipe.ts";
import { settleFromReceipts } from "../../money/reconcile.ts";
import { recordStatement, statementDue } from "../../money/statements.ts";
import { coinKey } from "./keys.ts";
import { orderTag } from "./orders.ts";
import { hyperliquidStatement, VENUE_FILL_TOOL } from "./statement.ts";

const ADDRESS = "0x00000000000000000000000000000000000a0b1c";

/** The statement as the sweep reads it: only when it is due. */
async function readWhenDue() {
  if (await statementDue("hyperliquid"))
    await recordStatement("hyperliquid", hyperliquidStatement(ADDRESS));
}

/** The account's fills as Hyperliquid lists them, each read answered from these by time. */
const venue = vi.hoisted(() => ({ fills: [] as Record<string, unknown>[] }));
vi.mock("./api.ts", async (original) => ({
  ...(await original<object>()),
  info: vi.fn(async (body: { startTime: number; endTime?: number }) =>
    venue.fills.filter(
      (fill) =>
        (fill.time as number) >= body.startTime &&
        (fill.time as number) <= (body.endTime ?? Date.now()),
    ),
  ),
}));

/** The orders open on the account and the markets it holds a position in; none unless a test says. */
const open = vi.hoisted(() => ({
  orders: [] as Record<string, unknown>[],
  positions: [] as string[],
}));
vi.mock("./open-orders.ts", async (original) => ({
  ...(await original<object>()),
  standingOrders: vi.fn(async () => open.orders),
}));
vi.mock("./account.ts", async (original) => ({
  ...(await original<object>()),
  // Every position these read is a long, as each order here buys.
  positionsOn: vi.fn(async () => open.positions.map((market) => ({ market, side: "long" }))),
}));

// A move's recipe, and wallets that are a stub rather than a wallet app's read.
const lookup = vi.hoisted(() => ({ recipe: undefined as unknown }));
vi.mock("../../money/recipes/index.ts", async (original) => ({
  ...(await original<object>()),
  recipeForTool: () => lookup.recipe,
}));
vi.mock("../../money/wallets.ts", async (original) => ({
  ...(await original<object>()),
  signerFor: async () => ({ evmAddress: ADDRESS }),
}));

/** The turns it woke. */
const wakes = () => queued("turn");

/** The cards left in a specialist's chat, oldest first. */
async function cardsIn(specialistId: string) {
  const rows = await db
    .select({ parts: messages.parts })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(eq(threads.specialistId, specialistId))
    .orderBy(asc(messages.createdAt));
  return rows.flatMap(({ parts }) =>
    (parts as { data: { cards: Record<string, unknown>[] } }[]).flatMap((part) => part.data.cards),
  );
}

/** The cards left in one thread, oldest first. */
async function cardsInThread(threadId: string) {
  const rows = await db
    .select({ parts: messages.parts })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));
  return rows.flatMap(({ parts }) =>
    (parts as { data?: { cards?: Record<string, unknown>[] } }[]).flatMap(
      (part) => part.data?.cards ?? [],
    ),
  );
}

/** One of the owner's chats, begun, last spoken in at `at`. */
async function chatAt(at: Date, fields: Partial<typeof threads.$inferInsert> = {}) {
  const chat = await insertThread({ title: "A chat", updatedAt: at, ...fields });
  await db.insert(messages).values({ threadId: chat.id, role: "user", parts: [], createdAt: at });
  return chat;
}

/** A fill as userFillsByTime lists one. */
function venueFill(fill: {
  coin: string;
  side: "B" | "A";
  sz: string;
  px: string;
  startPosition: string;
  time: Date;
  tid: number;
  dir?: string;
  closedPnl?: string;
  cloid?: string;
  liquidation?: object;
}) {
  const { time, ...rest } = fill;
  return {
    dir: "Open Long",
    closedPnl: "0.0",
    hash: `0x${"0".repeat(64)}`,
    oid: fill.tid,
    crossed: true,
    fee: "0.0",
    feeToken: "USDC",
    ...rest,
    time: time.getTime(),
  };
}

/** A move of Auni's on Hyperliquid, done, with what it filled as it once recorded it. */
async function filledBefore(
  specialistId: string,
  coin: string,
  quantity: string,
  usdValue: string,
  at: Date,
) {
  const action = await insertAction({
    tool: "hyperliquid_order",
    venue: "hyperliquid",
    status: "done",
    specialistId,
    createdAt: at,
  });
  await db.insert(fills).values({
    actionId: action.id,
    specialistId,
    ...coinKey(coin),
    side: "buy",
    quantity,
    usdValue,
    createdAt: at,
  });
  return action;
}

const fillsOf = (actionId: string) =>
  db.select().from(fills).where(eq(fills.actionId, actionId)).orderBy(asc(fills.quantity));

/** Reads the statement on from where it stopped, however lately it was read. */
const readAgain = () => recordStatement("hyperliquid", hyperliquidStatement(ADDRESS));

/** A Hyperliquid order of Auni's, opening `side` at 3x. */
function perpOrder(fields: Partial<typeof actions.$inferInsert> = {}) {
  return insertAction({
    tool: "hyperliquid_order",
    venue: "hyperliquid",
    status: "done",
    input: { market: "ETH", side: "long", leverage: 3, sizeUsd: 150, stopLoss: 2400 },
    ...fields,
  });
}

beforeEach(async () => {
  venue.fills = [];
  open.orders = [];
  open.positions = [];
  await wipe(specialists, actions, fills, arrivalCursors, threads, messages);
});

describe("the Hyperliquid statement", () => {
  // On Oct 14 Hyperliquid liquidated Starknet's STRK long, and nothing said so for 9 days.
  it("records a liquidation from before tags once, under the specialist that held it", async () => {
    const starknet = await insertSpecialist({ name: "Starknet" });
    const opened = new Date("2026-10-06T15:02:00Z");
    await filledBefore(starknet.id, "STRK", "193.1", "16.50", opened);
    const liquidated = new Date("2026-10-14T20:21:00Z");
    venue.fills = [
      // Auni's own buy, from before orders were tagged: recorded already, so passed by.
      venueFill({
        coin: "STRK",
        side: "B",
        sz: "193.1",
        px: "0.08545",
        startPosition: "0.0",
        time: opened,
        tid: 401,
      }),
      venueFill({
        coin: "STRK",
        side: "A",
        sz: "193.1",
        px: "0.07855",
        startPosition: "193.1",
        time: liquidated,
        tid: 498_999_898_257_703,
        dir: "Close Long",
        closedPnl: "-5.256182",
        liquidation: { liquidatedUser: ADDRESS, markPx: "0.07861", method: "market" },
      }),
    ];

    await readWhenDue();
    await readAgain();
    // Read again from the start, as a first read: still once.
    await db.delete(arrivalCursors);
    await readWhenDue();

    const outside = await db.select().from(actions).where(eq(actions.tool, VENUE_FILL_TOOL));
    expect(outside).toEqual([
      expect.objectContaining({
        status: "done",
        venue: "hyperliquid",
        summary: "Hyperliquid liquidated the STRK long: 193.1 sold at $0.07855, losing $5.26",
        createdAt: liquidated,
        details: expect.objectContaining({
          cause: "liquidation",
          market: "STRK",
          before: "193.1",
          after: "0",
          closedPnlUsd: "-5.256182",
        }),
      }),
    ]);
    expect(await fillsOf(outside[0]!.id)).toEqual([
      expect.objectContaining({
        specialistId: starknet.id,
        side: "sell",
        quantity: "193.100000000000000000",
        usdValue: "15.16",
        venueRef: `hyperliquid:${ADDRESS}:498999898257703`,
        createdAt: liquidated,
      }),
    ]);
    expect(await db.select().from(fills)).toHaveLength(2);
    // Told once, in Starknet's chat, which wakes once: there is something to decide.
    expect(await cardsIn(starknet.id)).toEqual([
      expect.objectContaining({
        kind: "venue_event",
        title: "Hyperliquid closed your STRK long",
        detail: "Its price moved against it until the margin behind it ran out. You lost $5.26.",
        actionReference: outside[0]!.id,
        outside: true,
      }),
    ]);
    expect(await wakes()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          reason: expect.stringContaining("Hyperliquid closed your STRK long."),
        }),
      }),
    ]);
  });

  it("owns a liquidation read late by who held it then, not by trades made after it", async () => {
    const specialist = await insertSpecialist();
    const opened = new Date("2026-10-06T15:02:00Z");
    await filledBefore(specialist.id, "ALGO", "10", "1.30", opened);
    const liquidated = new Date("2026-10-14T20:21:00Z");
    // Before tags, the same specialist later went short 10: its books now net to nothing.
    const shorted = await insertAction({
      tool: "hyperliquid_order",
      venue: "hyperliquid",
      status: "done",
      specialistId: specialist.id,
      createdAt: new Date("2026-10-20T09:00:00Z"),
    });
    await db.insert(fills).values({
      actionId: shorted.id,
      specialistId: specialist.id,
      ...coinKey("ALGO"),
      side: "sell",
      quantity: "10",
      usdValue: "1.10",
      createdAt: new Date("2026-10-20T09:00:00Z"),
    });
    venue.fills = [
      venueFill({
        coin: "ALGO",
        side: "A",
        sz: "10",
        px: "0.10",
        startPosition: "10.0",
        time: liquidated,
        tid: 77,
        dir: "Close Long",
        closedPnl: "-0.30",
        liquidation: { liquidatedUser: ADDRESS, markPx: "0.10", method: "market" },
      }),
    ];

    await readWhenDue();

    const [outside] = await db.select().from(actions).where(eq(actions.tool, VENUE_FILL_TOOL));
    expect(await fillsOf(outside!.id)).toEqual([
      expect.objectContaining({ specialistId: specialist.id, side: "sell", createdAt: liquidated }),
    ]);
  });

  it("records a stop Auni set firing later under its move, split between the specialists holding it", async () => {
    const first = await insertSpecialist();
    const second = await insertSpecialist();
    await filledBefore(first.id, "ETH", "2", "5000", new Date("2026-10-01T00:00:00Z"));
    await filledBefore(second.id, "ETH", "1", "2500", new Date("2026-10-02T00:00:00Z"));
    const stops = await insertAction({
      tool: "hyperliquid_set_stops",
      venue: "hyperliquid",
      status: "done",
      specialistId: second.id,
      input: { market: "ETH", stopLoss: 2400 },
      startedAt: new Date("2026-10-02T12:00:00Z"),
    });
    // Read through before the stop fired.
    await db
      .insert(arrivalCursors)
      .values({ chain: "hyperliquid", block: Date.parse("2026-10-03T00:00:00Z") });
    venue.fills = [
      venueFill({
        coin: "ETH",
        side: "A",
        sz: "3",
        px: "2400",
        startPosition: "3",
        time: new Date("2026-10-20T08:00:00Z"),
        tid: 7,
        dir: "Close Long",
        closedPnl: "-300.0",
        cloid: orderTag(stops.id, 0),
      }),
    ];

    await readWhenDue();
    await readAgain();

    // The stop's own specialist sells its share first, then the other specialist's, each with
    // its share of what the line locked in.
    expect(await fillsOf(stops.id)).toEqual([
      expect.objectContaining({
        specialistId: second.id,
        side: "sell",
        quantity: "1.000000000000000000",
        usdValue: "2400.00",
        pnlUsd: "-100.000000",
        venueRef: `hyperliquid:${ADDRESS}:7`,
      }),
      expect.objectContaining({
        specialistId: first.id,
        side: "sell",
        quantity: "2.000000000000000000",
        usdValue: "4800.00",
        pnlUsd: "-200.000000",
        venueRef: `hyperliquid:${ADDRESS}:7`,
      }),
    ]);
    expect(await db.select().from(actions).where(eq(actions.tool, VENUE_FILL_TOOL))).toEqual([]);
    // Each specialist is told of its share in its chat, and not woken: Auni's
    // own stop did what it was set to.
    const told = (share: string) => [
      expect.objectContaining({
        kind: "venue_event",
        title: "Your stop-loss closed your ETH long",
        detail: `It reached a stop-loss or take-profit price Auni set. You lost ${share}.`,
        actionReference: stops.id,
        outside: false,
      }),
    ];
    expect(await cardsIn(second.id)).toEqual(told("$100"));
    expect(await cardsIn(first.id)).toEqual(told("$200"));
    expect(await wakes()).toEqual([]);
  });

  it("tells of a stop no specialist held in the chat its position was opened in, not the latest", async () => {
    const opened = new Date(Date.now() - 30 * 60_000);
    const trading = await chatAt(new Date(opened.getTime() - 60_000));
    // A chat about something else, spoken in since: it is the latest, and not where this belongs.
    const later = await chatAt(new Date(opened.getTime() + 60_000));
    const settled = await chatAt(opened, { archivedAt: opened });
    const stopped = (order: { id: string }, tid: number) =>
      venueFill({
        coin: "ETH",
        side: "A",
        sz: "0.05",
        px: "2850",
        startPosition: "0.05",
        time: new Date(opened.getTime() + 20 * 60_000 + tid),
        tid,
        dir: "Close Long",
        closedPnl: "-7.5",
        cloid: orderTag(order.id, 1),
      });
    const inTrading = await perpOrder({
      threadId: trading.id,
      createdAt: opened,
      startedAt: opened,
    });
    // A move made in a chat the owner has since put away is told where they are now.
    const inSettled = await perpOrder({
      threadId: settled.id,
      createdAt: opened,
      startedAt: opened,
    });
    venue.fills = [stopped(inTrading, 41), stopped(inSettled, 42)];

    await readWhenDue();
    await readAgain();

    const stop = (actionReference: string) => [
      expect.objectContaining({
        kind: "venue_event",
        title: "Your stop-loss closed your ETH long",
        actionReference,
      }),
    ];
    expect(await cardsInThread(trading.id)).toEqual(stop(inTrading.id));
    expect(await cardsInThread(later.id)).toEqual(stop(inSettled.id));
    expect(await cardsInThread(settled.id)).toEqual([]);
  });

  it("records Auni's own market order once, from the statement rather than the venue's answer", async () => {
    const specialist = await insertSpecialist();
    const order = await insertAction({
      tool: "hyperliquid_order",
      venue: "hyperliquid",
      specialistId: specialist.id,
      input: { market: "BTC" },
    });
    lookup.recipe = {
      tool: "hyperliquid_order",
      description: "Opens a perp.",
      venue: "hyperliquid",
      input: { market: z.string() },
      about: () => null,
      describe: async () => ({
        summary: "Go long BTC",
        amountUsd: "10",
        effect: { gives: [{ text: "$10" }], gets: [{ text: "a BTC long" }], grants: [] },
      }),
      // Hyperliquid fills it the moment it's sent, and its fill carries the order's tag.
      execute: async ({ action, wallets }) => {
        venue.fills.push(
          venueFill({
            coin: "BTC",
            side: "B",
            sz: "0.0003",
            px: "80000",
            startPosition: "0.0",
            time: new Date(),
            tid: 9,
            cloid: orderTag(action.id, 0),
          }),
        );
        return {
          txs: [],
          fills: [],
          statement: hyperliquidStatement(wallets.evmAddress),
        };
      },
    } satisfies Recipe<{ market: z.ZodString }>;

    expect(await executeAction(order.id)).toMatchObject({ status: "done" });
    await readWhenDue();

    expect(await db.select().from(fills)).toEqual([
      expect.objectContaining({
        actionId: order.id,
        specialistId: specialist.id,
        side: "buy",
        quantity: "0.000300000000000000",
        usdValue: "24.00",
        venueRef: `hyperliquid:${ADDRESS}:9`,
      }),
    ]);
    // The move's own card tells it.
    expect(await cardsIn(specialist.id)).toEqual([]);
  });

  it("records a tagged limit that filled before the first read, though the books held nothing open", async () => {
    const specialist = await insertSpecialist();
    const placed = new Date(Date.now() - 20 * 60_000);
    const limit = await perpOrder({
      specialistId: specialist.id,
      createdAt: placed,
      startedAt: placed,
    });
    venue.fills = [
      venueFill({
        coin: "ETH",
        side: "B",
        sz: "0.05",
        px: "3000",
        startPosition: "0.0",
        time: new Date(Date.now() - 10 * 60_000),
        tid: 21,
        cloid: orderTag(limit.id, 0),
      }),
    ];

    await readWhenDue();

    expect(await fillsOf(limit.id)).toEqual([
      expect.objectContaining({
        specialistId: specialist.id,
        side: "buy",
        quantity: "0.050000000000000000",
        usdValue: "150.00",
        venueRef: `hyperliquid:${ADDRESS}:21`,
      }),
    ]);
    expect(await cardsIn(specialist.id)).toEqual([
      expect.objectContaining({ title: "Your limit order opened your ETH long", outside: false }),
    ]);
  });

  // The stops an order's card showed are on Hyperliquid before it fills (see stops.ts), so a
  // fill is covered. Hyperliquid uses one up if its price is reached while nothing is held,
  // which a take-profit's can be before a resting order fills: then the fill's news says so.
  const stopped = { market: "ETH", side: "long", sizeUsd: 300, leverage: 3 };
  const restingFill = (
    actionId: string,
    tid: number,
    startPosition: string,
    minutesAgo: number,
  ) => ({
    ...venueFill({
      coin: "ETH",
      side: "B",
      sz: "0.02",
      px: "3000",
      startPosition,
      time: new Date(Date.now() - minutesAgo * 60_000),
      tid,
      cloid: orderTag(actionId, 0),
    }),
    oid: 71,
  });
  /** A stop that closes a long: it sells. */
  const stop = {
    market: "ETH",
    isBuy: false,
    reduceOnly: true,
    size: null,
    filled: "0",
    waitsOn: null,
  };

  it("says so, and wakes the chat, when a limit order fills and a stop its card showed has gone", async () => {
    const placed = new Date(Date.now() - 20 * 60_000);
    const chat = await chatAt(placed);
    const limit = await perpOrder({
      threadId: chat.id,
      createdAt: placed,
      startedAt: placed,
      input: { ...stopped, stopLoss: 2700, takeProfit: 3600 },
    });
    // Two fills of one order, whose stop-loss is in place and whose take-profit is not.
    venue.fills = [restingFill(limit.id, 31, "0.0", 10), restingFill(limit.id, 32, "0.02", 5)];
    open.positions = ["ETH"];
    open.orders = [{ ...stop, oid: 72, kind: "stop-loss", price: "2700.0" }];

    await readWhenDue();

    // Said once, on the last fill read, and the chat is woken to offer the card that sets it.
    const said =
      "The take-profit at $3,600.00 this order's card showed is no longer on Hyperliquid, so your ETH position has none. Set it again if you still want it.";
    expect(await cardsInThread(chat.id)).toEqual([
      expect.objectContaining({ title: "Your limit order opened your ETH long", outside: false }),
      expect.objectContaining({
        title: "Your limit order added to your ETH long",
        outside: false,
        detail: `A limit order Auni placed earlier filled. 0.02 ETH bought at $3,000.00. ${said}`,
      }),
    ]);
    expect(await wakes()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          threadId: chat.id,
          reason: expect.stringContaining(
            `${said} An order of Auni's filled, and something its card showed is not in place, as said above.`,
          ),
        }),
      }),
    ]);
  });

  it("tells of a limit order that filled, and wakes nobody, while its card's stops are in place", async () => {
    const placed = new Date(Date.now() - 20 * 60_000);
    const chat = await chatAt(placed);
    const limit = await perpOrder({
      threadId: chat.id,
      createdAt: placed,
      startedAt: placed,
      input: { ...stopped, stopLoss: 2700, takeProfit: 3600 },
    });
    venue.fills = [restingFill(limit.id, 41, "0.0", 10)];
    open.positions = ["ETH"];
    open.orders = [
      { ...stop, oid: 72, kind: "stop-loss", price: "2700.0" },
      { ...stop, oid: 73, kind: "take-profit", price: "3600.0" },
    ];

    await readWhenDue();

    expect(await cardsInThread(chat.id)).toEqual([
      expect.objectContaining({
        title: "Your limit order opened your ETH long",
        detail: "A limit order Auni placed earlier filled. 0.02 ETH bought at $3,000.00.",
      }),
    ]);
    expect(await wakes()).toEqual([]);
  });

  it("never counts a stop that closes a short as the stop a long's card showed", async () => {
    const placed = new Date(Date.now() - 20 * 60_000);
    const chat = await chatAt(placed);
    const limit = await perpOrder({
      threadId: chat.id,
      createdAt: placed,
      startedAt: placed,
      input: { ...stopped, stopLoss: 2700 },
    });
    venue.fills = [restingFill(limit.id, 45, "0.0", 10)];
    open.positions = ["ETH"];
    // A stop-loss is listed, but it buys: it would close a short, and never touches this long.
    open.orders = [{ ...stop, isBuy: true, oid: 74, kind: "stop-loss", price: "3300.0" }];

    await readWhenDue();

    const [card] = await cardsInThread(chat.id);
    expect(String(card?.detail)).toContain(
      "The stop-loss at $2,700.00 this order's card showed is no longer on Hyperliquid",
    );
  });

  it("says nothing of stops for a position that has closed since, or an order that showed none", async () => {
    const placed = new Date(Date.now() - 20 * 60_000);
    const chat = await chatAt(placed);
    const gone = await perpOrder({
      threadId: chat.id,
      createdAt: placed,
      startedAt: placed,
      input: { ...stopped, stopLoss: 2700 },
    });
    const bare = await perpOrder({
      threadId: chat.id,
      createdAt: placed,
      startedAt: placed,
      input: { ...stopped, market: "BTC" },
    });
    // The first order's position is no longer open; the second showed no stops at all.
    venue.fills = [
      restingFill(gone.id, 51, "0.0", 10),
      { ...restingFill(bare.id, 52, "0.0", 9), coin: "BTC", oid: 81 },
    ];
    open.positions = ["BTC"];

    await readWhenDue();

    const cards = await cardsInThread(chat.id);
    expect(cards.map(({ detail }) => String(detail))).toEqual([
      "A limit order Auni placed earlier filled. 0.02 ETH bought at $3,000.00.",
      "A limit order Auni placed earlier filled. 0.02 BTC bought at $3,000.00.",
    ]);
    expect(await wakes()).toEqual([]);
  });

  it("tells of a stop firing after its move, read together with the move's own fill", async () => {
    const specialist = await insertSpecialist();
    const opened = new Date(Date.now() - 30 * 60_000);
    const order = await perpOrder({
      specialistId: specialist.id,
      createdAt: opened,
      startedAt: opened,
      endedAt: new Date(opened.getTime() + 5_000),
    });
    // The statement couldn't be read as it traded, so its next read finds both.
    venue.fills = [
      venueFill({
        coin: "ETH",
        side: "B",
        sz: "0.05",
        px: "3000",
        startPosition: "0.0",
        time: new Date(opened.getTime() + 2_000),
        tid: 31,
        cloid: orderTag(order.id, 0),
      }),
      venueFill({
        coin: "ETH",
        side: "A",
        sz: "0.05",
        px: "2850",
        startPosition: "0.05",
        time: new Date(opened.getTime() + 20 * 60_000),
        tid: 32,
        dir: "Close Long",
        closedPnl: "-7.5",
        cloid: orderTag(order.id, 1),
      }),
    ];

    await readWhenDue();
    await readAgain();

    expect((await fillsOf(order.id)).map(({ side }) => side)).toEqual(["buy", "sell"]);
    // The move's own fill is told by its card; the stop is news.
    expect(await cardsIn(specialist.id)).toEqual([
      expect.objectContaining({
        title: "Your stop-loss closed your ETH long",
        detail: "It reached a stop-loss or take-profit price Auni set. You lost $7.50.",
      }),
    ]);
  });

  it("tells of a tight stop that fires minutes after its move ended", async () => {
    const specialist = await insertSpecialist();
    // Live, 2026-11-16: a 0.3% stop on an ETH long fired three minutes after it opened.
    const opened = new Date(Date.now() - 10 * 60_000);
    const order = await perpOrder({
      specialistId: specialist.id,
      createdAt: opened,
      startedAt: opened,
      endedAt: new Date(opened.getTime() + 5_000),
    });
    venue.fills = [
      venueFill({
        coin: "ETH",
        side: "B",
        sz: "0.0055",
        px: "1822.9",
        startPosition: "0.0",
        time: new Date(opened.getTime() + 1_000),
        tid: 32,
        cloid: orderTag(order.id, 0),
      }),
      venueFill({
        coin: "ETH",
        side: "A",
        sz: "0.0055",
        px: "1815.2",
        startPosition: "0.0055",
        time: new Date(opened.getTime() + 3 * 60_000),
        tid: 33,
        dir: "Close Long",
        closedPnl: "-0.04235",
        cloid: orderTag(order.id, 1),
      }),
    ];

    await readWhenDue();

    // Its own fill is its card's to tell; the stop, though inside five minutes, is news.
    expect(await cardsIn(specialist.id)).toEqual([
      expect.objectContaining({ title: "Your stop-loss closed your ETH long" }),
    ]);
  });

  it("names the stop that fired by its order, though a stop-loss moved up closed at a gain", async () => {
    // Live, 2026-11-16: a stop-loss moved above the entry closed the long a cent up.
    const moved = new Date(Date.now() - 10 * 60_000);
    const chat = await chatAt(moved);
    const stops = await insertAction({
      tool: "hyperliquid_set_stops",
      venue: "hyperliquid",
      status: "done",
      threadId: chat.id,
      input: { market: "ETH", stopLoss: 1810 },
      createdAt: moved,
      startedAt: moved,
      endedAt: new Date(moved.getTime() + 1_000),
    });
    venue.fills = [
      venueFill({
        coin: "ETH",
        side: "A",
        sz: "0.0058",
        px: "1809.8",
        startPosition: "0.0058",
        time: new Date(moved.getTime() + 2_000),
        tid: 35,
        dir: "Close Long",
        closedPnl: "0.00986",
        cloid: orderTag(stops.id, 0),
      }),
    ];

    await readWhenDue();

    expect(await cardsInThread(chat.id)).toEqual([
      expect.objectContaining({ title: "Your stop-loss closed your ETH long" }),
    ]);
  });

  it("leaves what a move's orders fill while it runs to its own card", async () => {
    const specialist = await insertSpecialist();
    const placed = new Date(Date.now() - 5 * 60_000);
    const order = await perpOrder({
      specialistId: specialist.id,
      status: "running",
      phase: "sending",
      createdAt: placed,
      startedAt: placed,
    });
    venue.fills = [
      venueFill({
        coin: "ETH",
        side: "B",
        sz: "0.05",
        px: "3000",
        startPosition: "0.0",
        time: new Date(placed.getTime() + 1_000),
        tid: 34,
        cloid: orderTag(order.id, 0),
      }),
    ];

    await readWhenDue();

    expect((await fillsOf(order.id)).map(({ side }) => side)).toEqual(["buy"]);
    expect(await cardsIn(specialist.id)).toEqual([]);
  });

  it("keeps why a move stopped once the statement shows it traded after all", async () => {
    const specialist = await insertSpecialist();
    const placed = new Date(Date.now() - 20 * 60_000);
    const stopped =
      "Hyperliquid didn't confirm it, so it may have gone through (cancelling the resting order: Hyperliquid refused the attached stop, so any of it that fills has no stops).";
    const order = await perpOrder({
      specialistId: specialist.id,
      status: "running",
      createdAt: placed,
      startedAt: placed,
      error: stopped,
    });
    venue.fills = [
      venueFill({
        coin: "ETH",
        side: "B",
        sz: "0.05",
        px: "3000",
        startPosition: "0.0",
        time: new Date(placed.getTime() + 5_000),
        tid: 41,
        cloid: orderTag(order.id, 0),
      }),
    ];

    await readWhenDue();
    const [row] = await db.select().from(actions).where(eq(actions.id, order.id));

    expect(await settleFromReceipts(row!)).toMatchObject({ status: "done", error: stopped });
  });
});
