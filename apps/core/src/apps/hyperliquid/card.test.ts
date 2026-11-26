import { cardFaceSchema, fillFace } from "@auni/shared";
import { describe, expect, it } from "vitest";

import {
  cancelFace,
  closeFace,
  depositFace,
  leftoverFace,
  orderFace,
  stopsFace,
  withdrawFace,
} from "./card.ts";

const usdc = (baseUnits: string) => ({ baseUnits, currency: { code: "USDC", decimals: 6 } });
const order = {
  market: "BTC",
  side: "long" as const,
  leverage: 5,
  size: "$100.00",
  limit: null,
  liquidationMove: 0.19,
  stopLoss: "$90,000",
  takeProfit: null,
  stopLossWas: null,
  takeProfitWas: null,
  comeOff: [],
  adds: false,
};

describe("a Hyperliquid order's face", () => {
  it("reads as side, market and leverage, with the margin as what goes in", () => {
    const content = fillFace(orderFace(order), usdc("20000000"));
    expect(content.title).toBe("Long BTC at 5x");
    expect(content.action).toBe("Long BTC");
    expect(content.working).toBe("Opening your long");
    expect(content.context).toBe("Hyperliquid");
    expect(content.figures).toEqual([
      { label: "You put in", value: "$20", role: "pays" },
      { label: "You open, about", value: "a $100.00 position", role: "gets" },
      { label: "Leverage", value: "5x" },
      { label: "Stop-loss", value: "$90,000" },
    ]);
    expect(content.receipt).toEqual({
      title: "Opened a long on BTC",
      detail: "$100.00 at 5x on Hyperliquid, with a stop-loss at $90,000",
      amount: "$20",
    });
    // With no stops, it says none.
    expect(orderFace({ ...order, stopLoss: null }).receipt.detail).toBe(
      "$100.00 at 5x on Hyperliquid",
    );
  });

  it("says how far the price can go before the position is gone, then what holds its stops", () => {
    expect(orderFace(order).finePrint).toBe(
      "Hyperliquid closes it by itself, and what you put in is gone, if BTC falls about 19% from where it opens. Its stop-loss rests on Hyperliquid and closes the whole position at the market.",
    );
    const short = orderFace({ ...order, side: "short", takeProfit: "$80,000" });
    expect(short).toMatchObject({
      title: "Short BTC at 5x",
      finePrint:
        "Hyperliquid closes it by itself, and what you put in is gone, if BTC rises about 19% from where it opens. Its stop-loss and take-profit rest on Hyperliquid and close the whole position at the market.",
    });
    expect(short.figures.slice(-2)).toEqual([
      { label: "Stop-loss", value: "$90,000" },
      { label: "Take-profit", value: "$80,000" },
    ]);
    expect(orderFace({ ...order, stopLoss: null }).finePrint).toBe(
      "Hyperliquid closes it by itself, and what you put in is gone, if BTC falls about 19% from where it opens.",
    );
    expect(cardFaceSchema.parse(short)).toEqual(short);
  });

  // The stops are the position's: on Hyperliquid before anything fills, so a part that fills
  // is covered. Only a take-profit can be used up before then, and the card says so.
  it("says a limit order's stops hold from the moment it is placed", () => {
    expect(orderFace({ ...order, limit: "$95,000" }).finePrint).toBe(
      "It waits on Hyperliquid's book and opens only if BTC trades at $95,000 or better. Hyperliquid closes it by itself, and what you put in is gone, if BTC falls about 19% from where it opens. Its stop-loss rests on Hyperliquid from now and closes whatever has filled.",
    );
    expect(orderFace({ ...order, limit: "$95,000", takeProfit: "$120,000" }).finePrint).toMatch(
      / Its stop-loss and take-profit rest on Hyperliquid from now and close whatever has filled\. If BTC reaches \$120,000 before any of it fills, the take-profit is used up, and Auni tells you when it fills\.$/u,
    );
  });

  it("says its stops cover the position already held, from now, when it adds to one", () => {
    const add = orderFace({ ...order, limit: "$95,000", takeProfit: "$120,000", adds: true });
    // With something held, a take-profit is never used up, so nothing is said of that.
    expect(add.finePrint).toMatch(
      /from where it opens\. Its stop-loss and take-profit rest on Hyperliquid from now, on the position you already hold and whatever this adds\.$/u,
    );
    expect(orderFace({ ...order, adds: true }).finePrint).toMatch(
      / Its stop-loss rests on Hyperliquid from now, on the position you already hold and whatever this adds\.$/u,
    );
  });

  it("says a stop the position has already as moved, and a leftover one as coming off", () => {
    const moved = orderFace({ ...order, stopLossWas: "$85,000" });
    expect(moved.figures.at(-1)).toEqual({ label: "Stop-loss", value: "$90,000, was $85,000" });
    // One restated at the price it has is not said to move.
    expect(orderFace({ ...order, stopLossWas: "$90,000" }).figures.at(-1)).toEqual({
      label: "Stop-loss",
      value: "$90,000",
    });
    expect(orderFace({ ...order, comeOff: ["take-profit at $130,000"] }).finePrint).toMatch(
      / An earlier order's take-profit at \$130,000 comes off\.$/u,
    );
  });

  it("fits its fine print when everything is said at once", () => {
    const face = orderFace({
      ...order,
      market: "xyz:GOOGL",
      limit: "$195,000.50",
      takeProfit: "$250,000.50",
      comeOff: ["stop-loss at $185,000.50", "take-profit at $130,000.50"],
    });
    expect(face.finePrint!.length).toBeLessThanOrEqual(500);
  });

  it("names a stock's market by its ticker, without its dex", () => {
    expect(orderFace({ ...order, market: "xyz:NVDA" })).toMatchObject({
      title: "Long NVDA at 5x",
      action: "Long NVDA",
      receipt: { title: "Opened a long on NVDA" },
    });
  });

  // A limit order opens nothing until the market reaches it, so no word of its card says it has.
  it("says a limit order waits, and that placing it opened nothing", () => {
    const face = orderFace({ ...order, limit: "$88,000", stopLoss: null });
    expect(face.working).toBe("Placing your order");
    expect(face.figures.at(-1)).toEqual({ label: "Opens at", value: "$88,000 or better" });
    expect(face.finePrint).toMatch(
      /^It waits on Hyperliquid's book and opens only if BTC trades at \$88,000 or better\. /u,
    );
    expect(fillFace(face, usdc("20000000")).receipt).toEqual({
      title: "Placed an order to go long BTC",
      detail: "$100.00 at 5x on Hyperliquid, once BTC trades at $88,000 or better",
      amount: null,
    });
    // Its stops are on Hyperliquid once it is placed, so the receipt of placing it says them.
    expect(orderFace({ ...order, limit: "$88,000", takeProfit: "$120,000" }).receipt.detail).toBe(
      "$100.00 at 5x on Hyperliquid, once BTC trades at $88,000 or better, with a stop-loss at $90,000 and a take-profit at $120,000",
    );
  });
});

describe("a Hyperliquid close's face", () => {
  const close = {
    market: "BTC",
    side: "long" as const,
    percent: 100,
    size: "0.01627",
    worst: "$97,416",
    pnlUsd: 41.204,
    orderWaits: false,
  };

  it("says what it closes, what that has made, and the worst price it sells at", () => {
    const content = fillFace(closeFace(close), usdc("603260000"));
    expect(content).toMatchObject({
      title: "Close your BTC long",
      note: "back, if it all closes",
      action: "Close long",
      working: "Closing your BTC long",
      context: "Hyperliquid",
      figures: [
        { label: "Closes", value: "0.01627 BTC" },
        { label: "Gain so far", value: "+$41.20", tone: "gain" },
        { label: "Sells at no less than", value: "$97,416" },
      ],
      finePrint:
        "It closes at the market on Hyperliquid, or not at all if the price is past that by then. Any stop-loss or take-profit on it is cancelled with it.",
      receipt: {
        title: "Closed your BTC long",
        detail: "0.01627 BTC at the market on Hyperliquid",
        amount: "$603.26 back",
      },
    });
  });

  it("says a part by its share, a loss as a loss, and a short as bought back", () => {
    const face = closeFace({ ...close, side: "short", percent: 50, pnlUsd: -4.631 });
    expect(face).toMatchObject({
      title: "Close 50% of your BTC short",
      action: "Close 50%",
      figures: [
        { label: "Closes", value: "0.01627 BTC" },
        { label: "Loss so far", value: "-$4.63", tone: "loss" },
        { label: "Buys back at no more than", value: "$97,416" },
      ],
      finePrint:
        "It closes at the market on Hyperliquid, or not at all if the price is past that by then.",
      receipt: { title: "Closed 50% of your BTC short" },
    });
    // The position's stops stay while an order still waits to open more of it.
    expect(closeFace({ ...close, orderWaits: true }).finePrint).toBe(
      "It closes at the market on Hyperliquid, or not at all if the price is past that by then. Any stop-loss or take-profit on it stays, for the order still waiting to open more.",
    );
    // One that has made nothing either way says neither.
    expect(closeFace({ ...close, pnlUsd: 0.001 }).figures.map(({ label }) => label)).toEqual([
      "Closes",
      "Sells at no less than",
    ]);
    expect(cardFaceSchema.parse(face)).toEqual(face);
  });
});

describe("a change of stops' face", () => {
  const stops = {
    market: "ETH",
    side: "short" as const,
    now: "$3,431.20",
    stopLossWas: null,
    takeProfitWas: null,
  };

  it("names the exit it sets, its price, and the price now", () => {
    const face = stopsFace({ ...stops, stopLoss: undefined, takeProfit: "$3,050.00" });
    expect(face).toMatchObject({
      title: "Set a take-profit on your ETH short",
      action: "Set take-profit",
      working: "Setting a take-profit on your ETH short",
      figures: [
        { label: "Take-profit", value: "$3,050.00" },
        { label: "Price now", value: "$3,431.20" },
      ],
      finePrint:
        "Hyperliquid closes the whole position at the market once its price reaches it, however much the position has grown by then. Nothing moves until then.",
      receipt: {
        title: "Set a take-profit on your ETH short",
        detail: "Take-profit at $3,050.00",
        amount: null,
      },
    });
    expect(stopsFace({ ...stops, stopLoss: "$3,600.00", takeProfit: "$3,050.00" })).toMatchObject({
      title: "Set a stop-loss and take-profit on your ETH short",
      action: "Set stops",
      finePrint:
        "Hyperliquid closes the whole position at the market once its price reaches either, however much the position has grown by then. Nothing moves until then.",
      receipt: { detail: "Stop-loss at $3,600.00, take-profit at $3,050.00" },
    });
    expect(cardFaceSchema.parse(face)).toEqual(face);
  });

  it("says what a stop moves from when the position has one", () => {
    const face = stopsFace({
      ...stops,
      stopLoss: undefined,
      takeProfit: "$3,050.00",
      takeProfitWas: "$3,100.00",
    });
    expect(face.figures[0]).toEqual({ label: "Take-profit", value: "$3,050.00, was $3,100.00" });
  });

  it("says one it removes as removed, and both as a change", () => {
    expect(stopsFace({ ...stops, stopLoss: null, takeProfit: undefined })).toMatchObject({
      title: "Remove the stop-loss from your ETH short",
      action: "Remove stop-loss",
      figures: [
        { label: "Stop-loss", value: "Removed" },
        { label: "Price now", value: "$3,431.20" },
      ],
      finePrint: "Nothing moves now. The position stays open without it.",
      receipt: { title: "Removed the stop-loss from your ETH short", detail: "Stop-loss removed" },
    });
    expect(stopsFace({ ...stops, stopLoss: null, takeProfit: "$3,050.00" })).toMatchObject({
      title: "Change the stops on your ETH short",
      action: "Change stops",
      receipt: {
        title: "Changed the stops on your ETH short",
        detail: "Stop-loss removed, take-profit at $3,050.00",
      },
    });
  });
});

describe("a cancel's face", () => {
  const cancel = {
    market: "BTC",
    does: "go long",
    waiting: "0.00652 BTC",
    price: "$92,000",
    filled: null,
    stops: ["stop-loss at $85,000", "take-profit at $120,000"],
    stopsStayFor: null,
    attached: [],
  } as const;

  it("says the order's stops come off with it when nothing would be left for them", () => {
    const face = cancelFace(cancel);
    expect(face.finePrint).toBe(
      "Nothing is bought or sold: the order comes off Hyperliquid's book. Its stop-loss at $85,000 and take-profit at $120,000 come off with it.",
    );
    expect(cancelFace({ ...cancel, stops: [] }).finePrint).toBe(
      "Nothing is bought or sold: the order comes off Hyperliquid's book.",
    );
    expect(cardFaceSchema.parse(face)).toEqual(face);
  });

  it("says they stay for what has filled, for an open position, or for another order", () => {
    const part = cancelFace({ ...cancel, filled: "0.002 BTC", stopsStayFor: "position" });
    expect(part.finePrint).toBe(
      "Nothing more is bought or sold: the rest of the order comes off Hyperliquid's book, and what has filled stays open as your position. What has filled keeps its stop-loss at $85,000 and take-profit at $120,000.",
    );
    expect(cancelFace({ ...cancel, stopsStayFor: "position" }).finePrint).toMatch(
      / Your BTC position keeps its stop-loss at \$85,000 and take-profit at \$120,000\.$/u,
    );
    expect(
      cancelFace({ ...cancel, stops: ["stop-loss at $85,000"], stopsStayFor: "order" }).finePrint,
    ).toMatch(/ The stop-loss at \$85,000 stays, for the other order still waiting on BTC\.$/u);
  });

  // Only an order placed in Hyperliquid's own app carries stops of its own.
  it("says stops attached to the order itself are cancelled with it", () => {
    const face = cancelFace({
      ...cancel,
      filled: "0.002 BTC",
      stops: [],
      attached: ["stop-loss at $85,000"],
    });
    expect(face.finePrint).toMatch(
      / Its stop-loss at \$85,000 is cancelled with it, so what has filled has no stop\.$/u,
    );
  });

  it("says a leftover stop protects nothing, and what leaving it would do", () => {
    const face = leftoverFace({ market: "xyz:NVDA", kind: "stop-loss", price: "$150.00" });
    expect(face).toMatchObject({
      title: "Remove the leftover stop-loss on NVDA",
      action: "Remove stop-loss",
      figures: [
        { label: "Would fire at", value: "$150.00" },
        { label: "Protects", value: "Nothing now" },
      ],
      finePrint:
        "An order that has ended left it on Hyperliquid. Nothing is bought or sold. Left there, it would close the next NVDA position you open when NVDA reaches that price.",
      receipt: { title: "Removed the leftover stop-loss on NVDA", amount: null },
    });
    expect(cardFaceSchema.parse(face)).toEqual(face);
  });
});

describe("the faces of cash into and out of Hyperliquid", () => {
  // A little less arrives than leaves, so the card says what Circle keeps and what lands.
  it("says a deposit as cash moved in from the wallet, what Circle keeps and what arrives", () => {
    const face = depositFace({ from: "Arbitrum", arrives: "$9.80", fee: "$0.20" });
    expect(fillFace(face, usdc("10000000"))).toMatchObject({
      title: "Move cash into Hyperliquid",
      note: "to move",
      action: "Move $10",
      context: "From your wallet on Arbitrum",
      figures: [
        { label: "You send", value: "$10", role: "pays" },
        { label: "You get", value: "$9.80", role: "gets" },
        { label: "Circle keeps", value: "$0.20" },
        { label: "Arrives", value: "In about a minute" },
      ],
      receipt: {
        title: "Moved cash into Hyperliquid",
        detail: "$9.80 from your wallet on Arbitrum, after Circle's $0.20 fee",
        amount: "$10",
      },
    });
    expect(cardFaceSchema.parse(face)).toEqual(face);
  });

  it("says what a withdrawal lands once Hyperliquid keeps its fee", () => {
    const face = withdrawFace({ to: "Arbitrum", arrives: "$499", fee: "$1", all: false });
    expect(fillFace(face, usdc("500000000"))).toMatchObject({
      title: "Bring cash back from Hyperliquid",
      note: "to bring back",
      action: "Bring back $500",
      context: "To Arbitrum, after a $1 fee",
      figures: [
        { label: "Leaves Hyperliquid", value: "$500", role: "pays" },
        { label: "You get", value: "$499", role: "gets" },
        { label: "Hyperliquid keeps", value: "$1" },
        { label: "Arrives", value: "In a few minutes" },
      ],
      finePrint: "What your open positions hold as margin stays with them.",
      receipt: {
        title: "Brought cash back from Hyperliquid",
        detail: "$499 to your wallet on Arbitrum, after Hyperliquid's $1 fee",
        amount: null,
      },
    });
    expect(withdrawFace({ to: "Arbitrum", arrives: "$9.80", fee: "$1", all: true }).finePrint).toBe(
      "That is all the cash free there now. What your open positions hold as margin stays with them.",
    );
    expect(cardFaceSchema.parse(face)).toEqual(face);
  });
});
