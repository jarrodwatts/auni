import { readFileSync } from "node:fs";

import { cardFaceSchema } from "@auni/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { failureKind } from "../../money/failure.ts";
import type { Signer } from "../../money/recipe.ts";
import { Refused } from "../../money/refused.ts";
import { info, sendL1 } from "./api.ts";
import { hyperliquidCancelOrder } from "./cancel.ts";
import type { Market } from "./markets.ts";

const BTC: Market = {
  name: "BTC",
  dex: "",
  assetId: 0,
  szDecimals: 5,
  maxLeverage: 40,
  markPx: 100_000,
  dayVolumeUsd: 0,
  fundingRate: 0,
  collateralToken: 0,
};

/** What Hyperliquid answered, as it was recorded (see each fixture's `from`). */
const recorded = (name: string) =>
  (
    JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8")) as {
      readonly answer: unknown;
    }
  ).answer;

/** A limit order to buy 0.006 BTC at $92,000, as Hyperliquid lists one, with `left` still to fill. */
const listed = (left: string, children: readonly object[] = []) => ({
  coin: "BTC",
  side: "B",
  limitPx: "92000.0",
  sz: left,
  origSz: "0.006",
  oid: 7,
  timestamp: 1_794_467_565_753,
  isTrigger: false,
  triggerPx: "0.0",
  reduceOnly: false,
  orderType: "Limit",
  children,
});
const attached = (oid: number, orderType: string, triggerPx: string) => ({
  ...listed("0.006"),
  oid,
  side: "A",
  isTrigger: true,
  triggerPx,
  reduceOnly: true,
  orderType,
});
const STOPS = [attached(8, "Stop Market", "85000.0"), attached(9, "Take Profit Market", "99000.0")];
/** The position's stops as Auni sends them: for the whole position, beside the order, waiting on none. */
const OWN = STOPS.map((stop) => ({ ...stop, sz: "0.0", origSz: "0.0", isPositionTpsl: true }));

// Hyperliquid as the move reads it: the orders open, the position, and what became of order 7.
const world = vi.hoisted(() => ({
  open: [] as object[],
  szi: "0",
  status: null as unknown,
  cancel: "success" as unknown,
  sent: [] as unknown[],
}));

vi.mock(import("./api.ts"), async (original) => ({
  ...(await original()),
  info: vi.fn(async (body: Record<string, unknown>) => {
    if (body.type === "frontendOpenOrders") return world.open;
    if (body.type === "orderStatus") return world.status;
    if (body.type === "userAbstraction") return "unifiedAccount";
    if (body.type === "spotClearinghouseState") return { balances: [] };
    if (body.type === "clearinghouseState")
      return {
        withdrawable: "0",
        marginSummary: { accountValue: "0" },
        assetPositions:
          world.szi === "0"
            ? []
            : [
                {
                  position: {
                    coin: "BTC",
                    szi: world.szi,
                    entryPx: null,
                    liquidationPx: null,
                    unrealizedPnl: "0",
                    marginUsed: "10",
                    leverage: { value: 2 },
                  },
                },
              ],
      };
    throw new Error(`no answer for ${String(body.type)}`);
  }) as never,
  sendL1: vi.fn(async (_wallets, action) => {
    world.sent.push(action);
    if (world.cancel instanceof Error) throw world.cancel;
    return {
      status: "ok",
      response: { type: "cancel", data: { statuses: [world.cancel] } },
    } as never;
  }),
}));
vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  findMarket: vi.fn(async () => BTC),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: vi.fn(async () => "0x0000000000000000000000000000000000000001"),
}));

/** What Hyperliquid says of order 7 while it is open with `left` still to fill. */
const open = (left: string) => ({
  status: "order",
  order: { order: listed(left), status: "open", statusTimestamp: 0 },
});

/** What Hyperliquid says of order 7 once it was cancelled with `left` still unfilled. */
const cancelled = (left: string) => ({
  status: "order",
  order: { order: listed(left), status: "canceled", statusTimestamp: 0 },
});

beforeEach(() => {
  Object.assign(world, {
    open: [listed("0.006")],
    szi: "0",
    status: open("0.006"),
    cancel: "success",
    sent: [],
  });
  vi.mocked(sendL1).mockClear();
});

const card = () => hyperliquidCancelOrder.describe({ market: "BTC", order: "7" }, {});
/** Taps the card as `describe` saved it. */
const tap = async (details?: Record<string, string>) =>
  hyperliquidCancelOrder.execute({
    action: { id: "a", details: details ?? (await card()).details } as ActionRow,
    input: { market: "BTC", order: "7" },
    wallets: { evmAddress: "0x01" } as Signer,
    recordSent: async () => {},
    posting: (_chain, post) => post(),
  });

describe("a cancel's card", () => {
  it("says which order it cancels in the owner's words, and that nothing is bought or sold", async () => {
    const preview = await card();
    expect(preview).toMatchObject({
      summary: "Cancel your order to go long BTC on Hyperliquid",
      amountUsd: "0",
      effect: { gives: [], gets: [], grants: [] },
      details: { market: "BTC", order: "7", filled: "0" },
      card: {
        title: "Cancel your order to go long BTC",
        action: "Cancel order",
        context: "Hyperliquid",
        figures: [
          { label: "Still waiting", value: "0.006 BTC" },
          { label: "Waiting for", value: "$92,000 or better" },
          { label: "Filled so far", value: "Nothing" },
        ],
        finePrint: "Nothing is bought or sold: the order comes off Hyperliquid's book.",
        receipt: {
          title: "Cancelled your order to go long BTC",
          detail: "Nothing was bought or sold.",
          amount: null,
        },
      },
    });
    expect(cardFaceSchema.parse(preview.card)).toEqual(preview.card);
  });

  it("says the position's stops come off with it when nothing else is there for them", async () => {
    world.open = [...OWN, listed("0.006")];
    const preview = await card();
    // The stops it names are the only ones a tap takes off.
    expect(preview.details).toEqual({ market: "BTC", order: "7", filled: "0", stops: "8,9" });
    expect(preview.card?.finePrint).toBe(
      "Nothing is bought or sold: the order comes off Hyperliquid's book. Its stop-loss at $85,000 and take-profit at $99,000 come off with it.",
    );
  });

  it("says the position's stops stay for what has filled, or for another order still waiting", async () => {
    world.open = [...OWN, listed("0.004")];
    world.szi = "0.002";
    const part = await card();
    expect(part.details).not.toHaveProperty("stops");
    expect(part.card?.finePrint).toBe(
      "Nothing more is bought or sold: the rest of the order comes off Hyperliquid's book, and what has filled stays open as your position. What has filled keeps its stop-loss at $85,000 and take-profit at $99,000.",
    );
    world.szi = "0";
    world.open = [...OWN, listed("0.006"), { ...listed("0.006"), oid: 6 }];
    const other = await card();
    expect(other.details).not.toHaveProperty("stops");
    expect(other.card?.finePrint).toMatch(
      / The stop-loss at \$85,000 and take-profit at \$99,000 stay, for the other order still waiting on BTC\.$/u,
    );
  });

  // An order placed in Hyperliquid's own app can carry stops of its own, which wait on it.
  it("says what has filled stays open, and that stops attached to the order go with it", async () => {
    world.open = [...STOPS, listed("0.004", STOPS)];
    world.szi = "0.002";
    expect((await card()).card).toMatchObject({
      figures: [
        { label: "Still waiting", value: "0.004 BTC" },
        { label: "Waiting for", value: "$92,000 or better" },
        { label: "Filled so far", value: "0.002 BTC" },
      ],
      finePrint:
        "Nothing more is bought or sold: the rest of the order comes off Hyperliquid's book, and what has filled stays open as your position. Its stop-loss at $85,000 and take-profit at $99,000 are cancelled with it, so what has filled has no stops.",
      receipt: { detail: "0.002 BTC had filled and stays open. Nothing more was bought or sold." },
    });
  });

  it("says an order's stops go with it when nothing has filled, and no other order's", async () => {
    // Order 6 has a take-profit of its own waiting on it, which is not order 7's.
    const other = { ...STOPS[1]!, oid: 10 };
    world.open = [
      STOPS[0]!,
      listed("0.006", [STOPS[0]!]),
      other,
      { ...listed("0.006", [other]), oid: 6 },
    ];
    expect((await card()).card?.finePrint).toBe(
      "Nothing is bought or sold: the order comes off Hyperliquid's book. Its stop-loss at $85,000 is cancelled with it.",
    );
  });

  it("names an order that trades against the position by what it does", async () => {
    world.szi = "-0.01";
    expect((await card()).summary).toBe("Cancel your order to buy BTC on Hyperliquid");
    world.szi = "0.01";
    world.open = [{ ...listed("0.006"), side: "A", reduceOnly: true }];
    expect((await card()).summary).toBe("Cancel your order to sell BTC on Hyperliquid");
  });

  it("is offered only for a limit order that is open", async () => {
    world.open = [];
    await expect(card()).rejects.toThrow("There is no open order 7 on BTC.");
    // An order of that id on another market is not the one named.
    world.open = [{ ...listed("0.006"), coin: "ETH" }];
    await expect(card()).rejects.toThrow("There is no open order 7 on BTC.");
    // A stop on an open position is the position's, one beside an order still waiting is
    // there for what that order fills, and one that waits on an order goes with that order.
    world.open = [{ ...OWN[0], oid: 7 }];
    world.szi = "0.002";
    await expect(card()).rejects.toThrow(
      "Changing the position's stops with hyperliquid_set_stops removes it.",
    );
    world.szi = "0";
    world.open = [
      { ...OWN[0], oid: 7 },
      { ...listed("0.006"), oid: 6 },
    ];
    await expect(card()).rejects.toThrow("Cancelling that order takes it off.");
    world.open = [STOPS[0]!, { ...listed("0.006", [STOPS[0]!]), oid: 6 }];
    await expect(
      hyperliquidCancelOrder.describe({ market: "BTC", order: "8" }, {}),
    ).rejects.toThrow("waits on order 6");
  });

  it("is offered for a stop left over with nothing to protect, as a card of its own", async () => {
    world.open = [{ ...OWN[0], oid: 7 }];
    const preview = await card();
    expect(preview).toMatchObject({
      summary: "Remove a leftover stop-loss on BTC from Hyperliquid",
      amountUsd: "0",
      details: { market: "BTC", order: "7", leftover: "stop-loss" },
      card: { title: "Remove the leftover stop-loss on BTC", action: "Remove stop-loss" },
    });
  });
});

describe("a cancel allowed", () => {
  it("cancels the order its card showed and no other, and buys or sells nothing", async () => {
    expect(await tap()).toEqual({ txs: [], fills: [] });
    expect(world.sent).toEqual([{ type: "cancel", cancels: [{ a: BTC.assetId, o: 7 }] }]);
  });

  it("goes by its card, not by what the agent's input says by then", async () => {
    await tap({ market: "BTC", order: "41" }).catch(() => {});
    // Order 41 is not order 7: its status is asked for by its own id, and nothing else is sent.
    expect(vi.mocked(info).mock.calls.at(-1)?.[0]).toMatchObject({ type: "orderStatus", oid: 41 });
    await expect(tap({})).rejects.toThrow("doesn't say which order it cancels");
  });

  it("takes off the stops its card showed, once the order is off and nothing is left for them", async () => {
    world.open = [...OWN, listed("0.006")];
    const { details } = await card();
    // The order is gone from the book by the time the stops are read again.
    world.open = [...OWN];
    expect(await tap(details)).toEqual({ txs: [], fills: [] });
    expect(world.sent).toEqual([
      { type: "cancel", cancels: [{ a: BTC.assetId, o: 7 }] },
      {
        type: "cancel",
        cancels: [
          { a: BTC.assetId, o: 8 },
          { a: BTC.assetId, o: 9 },
        ],
      },
    ]);
  });

  it("takes off no stop its card didn't show", async () => {
    world.open = [OWN[0]!, listed("0.006")];
    const { details } = await card();
    // A take-profit set since the card is not this card's to remove.
    world.open = [...OWN];
    await tap(details);
    expect(world.sent.at(-1)).toEqual({ type: "cancel", cancels: [{ a: BTC.assetId, o: 8 }] });
  });

  it("leaves the stops on what filled between the card and the tap, and says so", async () => {
    world.open = [...OWN, listed("0.006")];
    const { details } = await card();
    world.status = open("0.004");
    world.szi = "0.002";
    world.open = [...OWN];
    expect(await tap(details)).toMatchObject({
      note: "0.002 BTC of the order had filled before it was cancelled, and stays open as your position. It keeps its stop-loss at $85,000 and take-profit at $99,000.",
    });
    expect(world.sent).toEqual([{ type: "cancel", cancels: [{ a: BTC.assetId, o: 7 }] }]);
  });

  it("says so when the stops could not be taken off with the order", async () => {
    world.open = [...OWN, listed("0.006")];
    const { details } = await card();
    world.open = [...OWN];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sendL1)
      .mockImplementationOnce(async () => ({
        status: "ok",
        response: { type: "cancel", data: { statuses: ["success"] } },
      }))
      .mockImplementationOnce(async () => {
        throw new Error("fetch failed");
      });
    expect(await tap(details)).toMatchObject({
      note: "The stops sent with the order could not be taken off, and may still be on Hyperliquid, where they would act on the next BTC position you open.",
    });
  });

  it("says what had filled before the cancel, and that it has no stops when it has none", async () => {
    world.status = open("0.004");
    world.szi = "0.002";
    expect(await tap()).toMatchObject({
      note: "0.002 BTC of the order had filled before it was cancelled, and stays open as your position. It has no stop-loss or take-profit.",
    });
  });

  it("says what filled between its read and the cancel, whether or not Hyperliquid answered", async () => {
    world.szi = "0.002";
    const note =
      "0.002 BTC of the order had filled before it was cancelled, and stays open as your position. It has no stop-loss or take-profit.";
    for (const answer of ["success", new Error("fetch failed")]) {
      world.cancel = answer;
      // Nothing had filled when it was read; by the cancel, 0.002 BTC had.
      world.status = cancelled("0.004");
      vi.mocked(info).mockResolvedValueOnce(open("0.006") as never);
      expect(await tap({ market: "BTC", order: "7" })).toMatchObject({ note });
    }
  });

  it("signs nothing for an order that filled in full since its card", async () => {
    const details = (await card()).details;
    world.status = recorded("orders/status-filled");
    const tapped = tap(details);
    await expect(tapped).rejects.toThrow(
      "That order is no longer open on Hyperliquid, so there was nothing to cancel. It had already filled in full, and what it traded is in your position.",
    );
    await expect(tapped).rejects.toBeInstanceOf(Refused);
    // The same step can't get past it by running again.
    expect(failureKind(await tapped.catch((error: unknown) => error))).toBe("rule");
    expect(sendL1).not.toHaveBeenCalled();
  });

  it("signs nothing for an order that was cancelled already, and says whether any of it filled", async () => {
    const details = (await card()).details;
    world.status = recorded("orders/status-canceled");
    await expect(tap(details)).rejects.toThrow(
      "That order is no longer open on Hyperliquid, so there was nothing to cancel. It had already been cancelled, with none of it filled.",
    );
    const { order } = world.status as { order: { order: { sz: string; origSz: string } } };
    world.status = {
      ...(world.status as object),
      order: { ...order, order: { ...order.order, sz: "0.52" } },
    };
    await expect(tap(details)).rejects.toThrow(
      "It had already been cancelled, after 0.3 BTC of it filled, which is in your position.",
    );
    world.status = { status: "unknownOid" };
    await expect(tap(details)).rejects.toThrow(
      /^That order is no longer open on Hyperliquid, so there was nothing to cancel\.$/u,
    );
    expect(sendL1).not.toHaveBeenCalled();
  });

  it("fails in the owner's words when the order goes between the read and the cancel", async () => {
    world.cancel = (
      recorded("problems/order-not-open") as {
        response: { data: { statuses: unknown[] } };
      }
    ).response.data.statuses[0];
    vi.mocked(info)
      .mockResolvedValueOnce(open("0.006") as never)
      .mockResolvedValueOnce(recorded("orders/status-filled") as never);
    await expect(tap({ market: "BTC", order: "7" })).rejects.toThrow(
      "That order is no longer open on Hyperliquid, so there was nothing to cancel. It had already filled in full, and what it traded is in your position.",
    );
  });

  it("is done when Hyperliquid never answered but the order is cancelled", async () => {
    world.cancel = new Error("fetch failed");
    vi.mocked(info)
      .mockResolvedValueOnce(open("0.006") as never)
      .mockResolvedValueOnce(recorded("orders/status-canceled") as never);
    expect(await tap({ market: "BTC", order: "7" })).toEqual({ txs: [], fills: [] });
  });

  it("is not done when Hyperliquid never answered and the order filled instead", async () => {
    world.cancel = new Error("fetch failed");
    world.status = recorded("orders/status-filled");
    vi.mocked(info).mockResolvedValueOnce(open("0.006") as never);
    await expect(tap({ market: "BTC", order: "7" })).rejects.toThrow("fetch failed");
  });

  it("fails as it is, to be tried again, when Hyperliquid never answered and the order still rests", async () => {
    world.cancel = new Error("fetch failed");
    const tapped = tap({ market: "BTC", order: "7" });
    await expect(tapped).rejects.toThrow("fetch failed");
    expect(failureKind(await tapped.catch((error: unknown) => error))).toBe("glitch");
  });
});

describe("a leftover stop's removal", () => {
  const leftover = { market: "BTC", order: "8", leftover: "stop-loss" };

  it("cancels that stop and no other", async () => {
    world.open = [...OWN];
    expect(await tap(leftover)).toEqual({ txs: [], fills: [] });
    expect(world.sent).toEqual([{ type: "cancel", cancels: [{ a: BTC.assetId, o: 8 }] }]);
  });

  it("signs nothing once a position or an order has come to need it", async () => {
    world.open = [...OWN];
    world.szi = "0.002";
    await expect(tap(leftover)).rejects.toThrow(
      "There is a BTC position or order now, which this stop protects, so nothing was sent.",
    );
    world.szi = "0";
    world.open = [...OWN, listed("0.006")];
    await expect(tap(leftover)).rejects.toThrow("so nothing was sent");
    expect(sendL1).not.toHaveBeenCalled();
  });

  it("signs nothing for one that has already gone", async () => {
    world.open = [];
    await expect(tap(leftover)).rejects.toThrow(
      "That order is no longer open on Hyperliquid, so there was nothing to cancel. It had already gone from Hyperliquid.",
    );
    expect(sendL1).not.toHaveBeenCalled();
  });
});
