import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { MayHaveSent, type Signer } from "../../money/recipe.ts";
import type { Market } from "./markets.ts";
import { hyperliquidOrder } from "./order.ts";

// An order's stops are the position's: Hyperliquid holds them for the whole position from
// before the entry is sent, so whatever fills is protected with Auni on or off (see stops.ts).
// These run the order against a Hyperliquid stood in for over fetch, and read what reached its
// exchange, in the order it was sent.

const SOL: Market = {
  name: "SOL",
  dex: "",
  assetId: 5,
  szDecimals: 2,
  maxLeverage: 20,
  markPx: 100,
  dayVolumeUsd: 1_000_000,
  fundingRate: 0,
  collateralToken: 0,
};
const OWNER = "0x00000000000000000000000000000000000000a1";
const ACTION = "5f0c2a8e-1b7d-4c3a-9e2f-0a1b2c3d4e5f";
const TAG = {
  entry: "0x5f0c2a8e1b7d4c3a9e2f0a1b2c3d4e00",
  first: "0x5f0c2a8e1b7d4c3a9e2f0a1b2c3d4e01",
};
const SECOND_TAG = "0x5f0c2a8e1b7d4c3a9e2f0a1b2c3d4e02";

interface Wire {
  readonly a: number;
  readonly b: boolean;
  readonly s: string;
  readonly r: boolean;
  readonly t: { readonly trigger?: { readonly triggerPx: string; readonly tpsl: "sl" | "tp" } };
  readonly c: string;
}
interface Posted {
  readonly type: string;
  readonly grouping?: string;
  readonly orders?: readonly Wire[];
  readonly cancels?: readonly { readonly o?: number; readonly cloid?: string }[];
}

const world = vi.hoisted(() => ({
  /** The SOL position's signed size. */
  szi: "0",
  /** Orders standing on Hyperliquid, as frontendOpenOrders lists them. */
  standing: [] as Record<string, unknown>[],
  /** What reached the exchange, in order. */
  posted: [] as Posted[],
  /** How the exchange answers the entry. */
  entry: { filled: { oid: 7, totalSz: "1", avgPx: "100" } } as unknown,
  /** The stops it refuses, by "sl" or "tp". */
  refuses: [] as string[],
  /** The requests that get no answer: "stops", "entry", "cancelByCloid", "cancel". */
  silent: [] as string[],
  /** What the exchange says as it turns the whole stops request away, if it does. */
  turnsAway: null as string | null,
  /** The cancels it refuses, as already gone, though the orders still stand: "cancelByCloid", "cancel". */
  wontCancel: [] as string[],
}));

vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  findMarket: vi.fn(async () => SOL),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => "0x00000000000000000000000000000000000000a1",
}));
vi.mock(import("../../money/typed-data.ts"), async (original) => ({
  ...(await original()),
  signTyped: vi.fn(async () => `0x${"11".repeat(32)}${"22".repeat(32)}1b` as const),
}));

/** A stop in place on SOL, as Hyperliquid lists one. */
const listedStop = (oid: number, tpsl: "sl" | "tp", triggerPx: string) => ({
  coin: "SOL",
  side: "A",
  limitPx: triggerPx,
  sz: "0.0",
  origSz: "0.0",
  oid,
  timestamp: 0,
  isTrigger: true,
  isPositionTpsl: true,
  triggerPx,
  reduceOnly: true,
  orderType: tpsl === "sl" ? "Stop Market" : "Take Profit Market",
  children: [],
  cloid: null,
});

function exchange(action: Posted): unknown {
  const kind =
    action.type !== "order" ? action.type : action.grouping === "positionTpsl" ? "stops" : "entry";
  world.posted.push(action);
  if (world.silent.includes(kind)) throw new TypeError("fetch failed");
  if (kind === "stops" && world.turnsAway) return { status: "err", response: world.turnsAway };
  if (kind === "stops") {
    const statuses = action.orders!.map((order, index) => {
      const { tpsl, triggerPx } = order.t.trigger!;
      if (world.refuses.includes(tpsl)) return { error: "Invalid TP/SL price." };
      // Listed from now on, under the tag it was sent with.
      world.standing.push({
        ...listedStop(900 + world.posted.length * 10 + index, tpsl, triggerPx),
        side: order.b ? "B" : "A",
        cloid: order.c,
      });
      return "waitingForTrigger";
    });
    return { status: "ok", response: { type: "order", data: { statuses } } };
  }
  if (kind === "entry")
    return { status: "ok", response: { type: "order", data: { statuses: [world.entry] } } };
  if (kind === "cancel" || kind === "cancelByCloid") {
    const named = (listed: Record<string, unknown>) =>
      action.cancels!.some(({ o, cloid }) =>
        kind === "cancel" ? o === listed.oid : cloid === listed.cloid,
      );
    if (world.wontCancel.includes(kind)) {
      const statuses = action.cancels!.map(() => ({
        error: "Order was never placed, already canceled, or filled.",
      }));
      return { status: "ok", response: { type: "cancel", data: { statuses } } };
    }
    world.standing = world.standing.filter((listed) => !named(listed));
    const statuses = action.cancels!.map(() => "success");
    return { status: "ok", response: { type: "cancel", data: { statuses } } };
  }
  return { status: "ok", response: { type: "default" } };
}

function info(body: Record<string, unknown>): unknown {
  switch (body.type) {
    case "userAbstraction":
      return "unifiedAccount";
    case "spotClearinghouseState":
      return { balances: [] };
    case "clearinghouseState": {
      const open = Number(world.szi) !== 0;
      const position = {
        coin: "SOL",
        szi: world.szi,
        entryPx: "100",
        liquidationPx: null,
        unrealizedPnl: "0",
        marginUsed: "50",
        leverage: { value: 2 },
      };
      return {
        withdrawable: "0",
        marginSummary: { accountValue: open ? "50" : "0" },
        assetPositions: open ? [{ position }] : [],
      };
    }
    case "frontendOpenOrders":
      return world.standing;
    default:
      throw new Error(`The fake Hyperliquid has no answer for ${String(body.type)}`);
  }
}

beforeEach(() => {
  Object.assign(world, {
    szi: "0",
    standing: [],
    posted: [],
    entry: { filled: { oid: 7, totalSz: "1", avgPx: "100" } },
    refuses: [],
    silent: [],
    turnsAway: null,
    wontCancel: [],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return Response.json(
        String(url).endsWith("/exchange") ? exchange(body.action as Posted) : info(body),
      );
    }),
  );
});

const parse = (change: object) =>
  z.object(hyperliquidOrder.input).parse({
    market: "SOL",
    side: "long",
    sizeUsd: 100,
    leverage: 2,
    stopLoss: 90,
    takeProfit: 120,
    ...change,
  });
/** Runs an order for $100 of SOL (1 SOL at the mark) with a stop-loss and a take-profit. */
const run = (change: object = {}, attempts = 1) =>
  hyperliquidOrder.execute({
    action: { id: ACTION, details: {}, attempts } as ActionRow,
    input: parse(change),
    wallets: { evmAddress: OWNER } as Signer,
    recordSent: async () => {},
    posting: (_chain, post) => post(),
  });
const limit = { orderType: "limit", limitPrice: 95 };
const noStops = { stopLoss: undefined, takeProfit: undefined };

/** What reached the exchange after the leverage was set, each request in a few words. */
const sent = () =>
  world.posted
    .filter(({ type }) => type !== "updateLeverage")
    .map((action) => {
      if (action.type === "cancel") return `cancel ${action.cancels!.map(({ o }) => o).join(",")}`;
      if (action.type === "cancelByCloid")
        return `take back ${action.cancels!.map(({ cloid }) => cloid!.slice(-2)).join(",")}`;
      if (action.grouping === "positionTpsl")
        return `stops ${action.orders!.map(({ t }) => `${t.trigger!.tpsl}@${t.trigger!.triggerPx}`).join(",")}`;
      return "entry";
    });

describe("the stops an order's card showed", () => {
  it("are on Hyperliquid for the whole position before the entry is sent", async () => {
    const ran = await run();
    expect(sent()).toEqual(["stops sl@90,tp@120", "entry"]);
    const [stops, entry] = world.posted.filter(({ type }) => type === "order");
    // Each can only close, on this market, sized to the whole position whatever it comes to.
    expect(stops!.orders).toEqual([
      expect.objectContaining({ a: SOL.assetId, b: false, s: "0", r: true, c: TAG.first }),
      expect.objectContaining({ a: SOL.assetId, b: false, s: "0", r: true, c: SECOND_TAG }),
    ]);
    // The entry is alone in its request, tagged first of the move's orders.
    expect(entry).toMatchObject({ grouping: "na", orders: [{ b: true, r: false, c: TAG.entry }] });
    expect(ran).not.toHaveProperty("note");
    expect(ran).toHaveProperty("statement");
  });

  it("cover a part fill with nothing more to send", async () => {
    world.entry = { filled: { oid: 7, totalSz: "0.4", avgPx: "100" } };
    expect(await run()).not.toHaveProperty("note");
    expect(sent()).toEqual(["stops sl@90,tp@120", "entry"]);
  });

  it("rest beside a limit order from the moment it is placed", async () => {
    world.entry = { resting: { oid: 7 } };
    // Nothing has filled, so there is no statement to read.
    expect(await run(limit)).toEqual({ txs: [], fills: [] });
    expect(sent()).toEqual(["stops sl@90,tp@120", "entry"]);
  });

  it("come back off when Hyperliquid refuses the entry, so nothing is left behind", async () => {
    world.entry = { error: "Order could not immediately match against any resting orders." };
    await expect(run()).rejects.toThrow(
      "The price moved past the worst price on your card before the order could fill, so nothing was bought or sold. The stops sent ahead of it were taken off again.",
    );
    expect(sent()).toEqual(["stops sl@90,tp@120", "entry", "take back 01,02"]);
  });

  it("stay when the entry got no answer, since it may be on the book", async () => {
    world.silent = ["entry"];
    await expect(run(limit)).rejects.toBeInstanceOf(MayHaveSent);
    expect(sent()).toEqual(["stops sl@90,tp@120", "entry"]);
  });

  it("are all or none: one refused takes the other back, and the entry is never sent", async () => {
    world.refuses = ["tp"];
    await expect(run()).rejects.toThrow(
      "Hyperliquid refused the stop's price. A stop-loss or take-profit has to sit past the market's price now, or it would fire the moment it was set. The order was not sent, so nothing was opened.",
    );
    expect(sent()).toEqual(["stops sl@90,tp@120", "take back 01"]);
  });

  it("are taken back, and the entry never sent, when Hyperliquid doesn't answer for them", async () => {
    world.silent = ["stops"];
    const failed = await run().catch((error: unknown) => error);
    // Nothing was opened, so the move fails plainly: it is not left unsure.
    expect(failed).not.toBeInstanceOf(MayHaveSent);
    expect((failed as Error).message).toBe(
      "Hyperliquid didn't answer when the stops were sent. The order was not sent, so nothing was opened.",
    );
    expect(sent()).toEqual(["stops sl@90,tp@120", "take back 01,02"]);
  });

  it("fail the move in Hyperliquid's own words when it turns the whole request away", async () => {
    world.turnsAway =
      "User or API Wallet 0x00000000000000000000000000000000000000a1 does not exist.";
    await expect(run()).rejects.toThrow(
      "This wallet has no Hyperliquid account yet. Moving $1 or more of USDC into Hyperliquid opens one. The order was not sent, so nothing was opened.",
    );
    // None of them is in place, so there is nothing to take back, and the entry is never sent.
    expect(sent()).toEqual(["stops sl@90,tp@120"]);
  });

  it("are said to perhaps remain when they can't be taken back", async () => {
    world.entry = { error: "Insufficient margin to place order." };
    world.silent = ["cancelByCloid"];
    world.wontCancel = ["cancel"];
    await expect(run()).rejects.toThrow(
      "so nothing was opened. A stop sent with it may still be on Hyperliquid, where it can only close a position, never open one.",
    );
  });

  // Hyperliquid's answer to a cancel is checked against what it lists: a refusal that says an
  // order is already gone is believed only once the order isn't listed.
  it("are taken off by their ids when a cancel by their tags is refused while they stand", async () => {
    world.entry = { error: "Insufficient margin to place order." };
    world.wontCancel = ["cancelByCloid"];
    await expect(run()).rejects.toThrow("The stops sent ahead of it were taken off again.");
    expect(sent().at(-2)).toBe("take back 01,02");
    expect(sent().at(-1)).toMatch(/^cancel \d+,\d+$/u);
    expect(world.standing).toEqual([]);
  });

  // A try that failed took its stops back off, and Try again sends them once more. The
  // entry keeps its one tag, so it can never be placed twice; the stops get new ones.
  it("are tagged anew on a second attempt, while the entry keeps its tag for life", async () => {
    await run({}, 2);
    const [stops, entry] = world.posted.filter(({ type }) => type === "order");
    expect(stops!.orders!.map(({ c }) => c.slice(-2))).toEqual(["03", "04"]);
    expect(entry!.orders![0]!.c).toBe(TAG.entry);
    world.posted = [];
    world.entry = { error: "Insufficient margin to place order." };
    await run({}, 3).catch(() => {});
    expect(sent()).toEqual(["stops sl@90,tp@120", "entry", "take back 05,06"]);
  });

  it("are not sent for an order that shows none", async () => {
    await run(noStops);
    expect(sent()).toEqual(["entry"]);
  });
});

describe("an order for a position that has stops already", () => {
  beforeEach(() => {
    world.szi = "1";
    world.standing = [listedStop(11, "sl", "85"), listedStop(12, "tp", "130")];
  });

  it("moves the kind it sets: the new one on, the entry, then the old one off", async () => {
    expect(await run({ takeProfit: undefined })).not.toHaveProperty("note");
    // The take-profit it didn't name stays as it is.
    expect(sent()).toEqual(["stops sl@90", "entry", "cancel 11"]);
  });

  it("leaves the position's own stops as they were when the entry is refused", async () => {
    world.entry = { error: "Insufficient margin to place order." };
    await expect(run()).rejects.toThrow("The stops sent ahead of it were taken off again.");
    expect(sent()).toEqual(["stops sl@90,tp@120", "entry", "take back 01,02"]);
  });

  it("leaves them alone when it shows none", async () => {
    await run(noStops);
    expect(sent()).toEqual(["entry"]);
  });

  it("says so when the earlier stop could not be taken off", async () => {
    world.silent = ["cancel"];
    expect(await run({ takeProfit: undefined })).toMatchObject({
      note: "The earlier stop-loss at $85.00 could not be taken off, and may still be in place.",
    });
  });

  it("says on its card what each stop moves from", async () => {
    const { card } = await hyperliquidOrder.describe(parse({ takeProfit: undefined }), {});
    expect(card?.figures).toContainEqual({ label: "Stop-loss", value: "$90.00, was $85.00" });
    expect(card?.finePrint).not.toContain("earlier order");
  });

  it("refuses stops on an order that trades against it", async () => {
    world.szi = "-1";
    await expect(hyperliquidOrder.describe(parse({}), {})).rejects.toThrow(
      "There is an open SOL short, which this order trades against, so it can't set a stop-loss or take-profit.",
    );
    await expect(run()).rejects.toThrow("trades against");
    expect(world.posted).toEqual([]);
    // Without stops it is an order like any other.
    await run(noStops);
    expect(sent()).toEqual(["entry"]);
  });
});

describe("stops an order that ended left on Hyperliquid", () => {
  // Nothing is held and nothing waits, so these would act on whatever is opened next.
  beforeEach(() => {
    world.standing = [listedStop(11, "sl", "85"), listedStop(12, "tp", "130")];
  });

  it("come off with the next order on that market, which says so on its card", async () => {
    const { card } = await hyperliquidOrder.describe(parse(noStops), {});
    expect(card?.finePrint).toContain(
      "An earlier order's stop-loss at $85.00 and take-profit at $130.00 come off.",
    );
    await run(noStops);
    expect(sent()).toEqual(["entry", "cancel 11,12"]);
  });

  it("are replaced by the order's own, and the kind it doesn't set comes off too", async () => {
    await run({ takeProfit: undefined });
    expect(sent()).toEqual(["stops sl@90", "entry", "cancel 11,12"]);
  });

  it("stay while another order still waits to open, since they protect what it fills", async () => {
    world.standing.push({
      ...listedStop(13, "sl", "0.0"),
      side: "B",
      isTrigger: false,
      reduceOnly: false,
      orderType: "Limit",
      limitPx: "92",
      sz: "1",
      origSz: "1",
    });
    await run(noStops);
    expect(sent()).toEqual(["entry"]);
  });
});

// A position has one stop-loss and one take-profit, and each closes one side only: a long's sells,
// a short's buys. Hyperliquid uses a stop up when it fires. So stops that would leave an order
// still waiting on the market with none are refused before anything is signed.
describe("stops that would leave an order still waiting bare", () => {
  /** An order of Auni's waiting on SOL: "B" to go long, "A" to go short. */
  const waiting = (oid: number, side: "B" | "A", limitPx: string) => ({
    ...listedStop(oid, "sl", "0.0"),
    side,
    isTrigger: false,
    reduceOnly: false,
    orderType: "Limit",
    limitPx,
    sz: "1",
    origSz: "1",
  });

  it("refuses stops on an order that opens the other way from one waiting", async () => {
    // A long waits at $85 with its sell stop at $80; a short with stops would take that stop off.
    world.standing = [waiting(21, "B", "85"), listedStop(22, "sl", "80")];
    const short = { side: "short", stopLoss: 120, takeProfit: 80 };
    const said =
      "A long order waits on SOL at $85.00, and a position's stops close one side only: stops for this short would take off the ones that order relies on. Cancel that order first, or send this without a stop-loss or take-profit.";
    await expect(hyperliquidOrder.describe(parse(short), {})).rejects.toThrow(said);
    await expect(run(short)).rejects.toThrow(said);
    expect(world.posted).toEqual([]);
    // Without stops it goes, and the long's stop stays.
    await run({ side: "short", ...noStops });
    expect(sent()).toEqual(["entry"]);
  });

  it("refuses a stop-loss the price must pass before an order waiting on its side can fill", async () => {
    world.standing = [waiting(21, "B", "85"), listedStop(22, "sl", "80")];
    await expect(run({ stopLoss: 90 })).rejects.toThrow(
      "A long order still waits on SOL at $85.00, below this stop-loss at $90.00: the stop would fire before that order could fill, and a stop that fires is used up, so the order would then fill with no stop. Set the stop-loss below $85.00, or cancel that order first.",
    );
    expect(world.posted).toEqual([]);
    // Below the waiting order's limit, it protects both.
    await run({ stopLoss: 82 });
    expect(sent()).toEqual(["stops sl@82,tp@120", "entry", "cancel 22"]);
  });
});

describe("a limit order's stops", () => {
  it("must be past the price now, since they rest on Hyperliquid before it fills", async () => {
    // Above the $95 limit, but under the $100 the market trades at: it would fire at once.
    const early = hyperliquidOrder.describe(parse({ ...limit, takeProfit: 98 }), {});
    await expect(early).rejects.toThrow(
      "A long take-profit must sit above 100; 98 would trigger immediately. A limit order's stops rest on Hyperliquid from the moment it is placed. Leave this one off, and set it with hyperliquid_set_stops once the order has filled.",
    );
    await expect(run({ ...limit, takeProfit: 98 })).rejects.toThrow("would trigger immediately");
    expect(world.posted).toEqual([]);
  });

  it("say on the card what holds from when", async () => {
    const { card } = await hyperliquidOrder.describe(parse(limit), {});
    expect(card?.finePrint).toBe(
      "It waits on Hyperliquid's book and opens only if SOL trades at $95.00 or better. Hyperliquid closes it by itself, and what you put in is gone, if SOL falls about 49% from where it opens. Its stop-loss and take-profit rest on Hyperliquid from now and close whatever has filled. If SOL reaches $120.00 before any of it fills, the take-profit is used up, and Auni tells you when it fills.",
    );
  });
});
