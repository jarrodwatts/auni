import { expect, vi } from "vitest";

import { holdsToCard } from "../../test/held-to-card.ts";
import type { Market } from "./markets.ts";

// Hyperliquid as its API answers, stood in for over fetch: the owner's account with two limit
// orders waiting on SOL, order 7 with nothing filled and order 8 filled in part. What reaches
// the exchange is what the owner's wallet signed for, so the drill reads it from `posted`.
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

const resting = (oid: number, left: string) => ({
  coin: "SOL",
  side: "B",
  limitPx: "90.0",
  sz: left,
  origSz: "1.0",
  oid,
  timestamp: 1_794_467_565_753,
  isTrigger: false,
  triggerPx: "0.0",
  reduceOnly: false,
  orderType: "Limit",
  children: [],
});
const OPEN = [resting(7, "1.0"), resting(8, "0.4")];

const world = vi.hoisted(() => ({ posted: [] as unknown[] }));

vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  findMarket: vi.fn(async () => SOL),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
}));

/** What Hyperliquid's /info answers for each read the move makes. */
function infoAnswer(body: Record<string, unknown>): unknown {
  switch (body.type) {
    case "frontendOpenOrders":
      return OPEN;
    case "orderStatus": {
      const order = OPEN.find(({ oid }) => oid === body.oid);
      return order
        ? { status: "order", order: { order, status: "open" } }
        : { status: "unknownOid" };
    }
    case "userAbstraction":
      return "unifiedAccount";
    case "spotClearinghouseState":
      return { balances: [] };
    case "clearinghouseState":
      return { withdrawable: "0", marginSummary: { accountValue: "0" }, assetPositions: [] };
    default:
      throw new Error(`The fake Hyperliquid has no answer for ${String(body.type)}`);
  }
}

holdsToCard("hyperliquid_cancel_order", {
  world() {
    world.posted = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        if (!String(url).endsWith("/exchange")) return Response.json(infoAnswer(body));
        world.posted.push(body.action);
        return Response.json({
          status: "ok",
          response: { type: "cancel", data: { statuses: ["success"] } },
        });
      }),
    );
  },
  asShown: {
    "a limit order still waiting": { market: "SOL", order: "7" },
    "one that has filled in part": { market: "SOL", order: "8" },
  },
  paysAsShown(signed, card) {
    // Nothing leaves the wallet, and the one thing signed is a cancel of the order its card
    // showed and no other: no order is placed, so nothing is bought or sold.
    expect(signed.evm).toEqual([]);
    expect(world.posted).toEqual([
      { type: "cancel", cancels: [{ a: SOL.assetId, o: Number(card.details.order) }] },
    ]);
  },
  priceMoved: { never: "it buys and sells nothing, so no price reaches it" },
  takesMore: {
    never:
      "it spends nothing: it takes one order off the book, the one its card pinned (cancel.test.ts)",
  },
  paysElsewhere: { never: "it moves no money anywhere, in or out of the account" },
});
