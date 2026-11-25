import { NETWORKS, withArticle } from "@auni/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { arrivals } from "../db/schema.ts";
import { activityOf, stepsOf, titleOf, when, type ActivityFacts, type Leg } from "./activity.ts";
import { happenedWords } from "./news.ts";
import { orderOf, type Exit, type Happened } from "./venue-statement.ts";

const STARKNET = "00000000-0000-4000-8000-0000000000c1";
const PEARL_BET = "00000000-0000-4000-8000-0000000000c2";
const PROPOSAL = "00000000-0000-4000-8000-0000000000a1";
const SYDNEY = "Australia/Sydney";

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T00:00:00Z"));
});
afterAll(() => vi.useRealTimers());

let ids = 0;
function leg(does: Leg["does"], fields: Partial<Leg> = {}): Leg {
  ids += 1;
  return {
    id: `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`,
    proposalId: PROPOSAL,
    threadId: PEARL_BET,
    touches: [PEARL_BET],
    at: new Date("2026-10-20T08:30:00Z"),
    does,
    story: null,
    ...fields,
  };
}
const sale = (name: string, usd: string) => leg({ kind: "sale", name, usd, logo: null });
const cash = (move: "between_wallets" | "to_hyperliquid", usd: string) =>
  leg({
    kind: "cash",
    move:
      move === "between_wallets"
        ? { kind: move, from: "monad", to: "arbitrum" }
        : { kind: "to_account", place: "hyperliquid" },
    usd,
  });
function pick(verb: string, name: string, step: string, usd: string | null, fields = {}) {
  return leg(
    {
      kind: "pick",
      verb,
      name,
      step,
      money: usd === null ? null : { flow: verb === "Closed" ? "back" : "in", usd },
      logo: { src: `https://app.hyperliquid.xyz/coins/${name}.svg`, name },
    },
    fields,
  );
}

/**
 * The Pearl card as it ran: four things held loose sold to USDC (Circle and
 * Coinbase xStocks, SOL, WETH), the cash bridged to Arbitrum and deposited
 * into Hyperliquid, and Pearl opened 1x long.
 */
const pearlCard = () => [
  sale("Circle", "5.10"),
  sale("Coinbase", "4.80"),
  sale("SOL", "4.30"),
  sale("WETH", "4.50"),
  cash("between_wallets", "17.00"),
  cash("to_hyperliquid", "17.00"),
  pick("Bought", "Pearl", "Opened Pearl, 1x long", "16.50"),
];

function facts(fields: Partial<ActivityFacts> = {}): ActivityFacts {
  return {
    legs: [],
    outside: [],
    arrivals: [],
    threads: new Map([
      [STARKNET, "Starknet"],
      [PEARL_BET, "Pearl bet"],
    ]),
    seenAt: new Date("2026-10-21T00:00:00Z"),
    timeZone: SYDNEY,
    ...fields,
  };
}

describe("folding moves", () => {
  it("makes one item of a card's legs, its plumbing only the steps of how", () => {
    const before = pick("Bought", "HYPE", "Opened HYPE, 2x long", "10.00", {
      proposalId: null,
      at: new Date("2026-10-10T00:00:00Z"),
    });
    const { items } = activityOf(facts({ legs: [before, ...pearlCard()] }), null);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      kind: "move",
      id: PROPOSAL,
      title: "Bought Pearl",
      subtitle: "Pearl bet, Oct 20 at 7:30pm",
      amount: { usd: "16.50", direction: null, tone: "neutral" },
      threadId: PEARL_BET,
      logo: { src: "https://app.hyperliquid.xyz/coins/Pearl.svg", name: "Pearl" },
      at: "2026-10-20T08:30:00.000Z",
      unread: false,
      receipt: {
        steps: [
          { text: "Sold 4 other holdings", amountUsd: "18.70", logoUrl: null },
          // The bridge was only on its way into Hyperliquid, so the move in says it.
          // Wearing the mark of where the cash went.
          {
            text: "Moved cash to Hyperliquid",
            amountUsd: "17.00",
            logoUrl: "/logos/hyperliquid.svg",
          },
          {
            text: "Opened Pearl, 1x long",
            amountUsd: "16.50",
            logoUrl: "https://app.hyperliquid.xyz/coins/Pearl.svg",
          },
        ],
        // A card of several moves is told by its steps; only a move of one is told whole.
        story: null,
      },
    });
  });

  it("names a thread's first card by what it bought", () => {
    const { items } = activityOf(facts({ legs: pearlCard() }), null);
    expect(items.map((item) => item.title)).toEqual(["Bought Pearl"]);
  });

  it("names a card that only moved cash, or sold what they held loose, by what it did", () => {
    const { items } = activityOf(
      facts({
        legs: [
          cash("to_hyperliquid", "20.00"),
          cash("between_wallets", "5.00"),
          sale("SOL", "3.00"),
        ].map((one, index) => ({
          ...one,
          proposalId: null,
          at: new Date(Date.parse("2026-10-20T08:30:00Z") + index * 60_000),
        })),
      }),
      null,
    );
    expect(items.map(({ title, amount }) => [title, amount])).toEqual([
      ["Sold SOL", { usd: "3.00", direction: null, tone: "neutral" }],
      // A move between their own wallets says which networks, so a bridge reads as one.
      ["Moved cash from Monad to Arbitrum", { usd: "5.00", direction: null, tone: "neutral" }],
      ["Moved cash to Hyperliquid", { usd: "20.00", direction: null, tone: "neutral" }],
    ]);
  });

  it("says a card's picks by what each did, in the order they ran", () => {
    expect(
      titleOf([
        { verb: "Closed", name: "Meta" },
        { verb: "Bought", name: "Micron" },
      ]),
    ).toBe("Closed Meta, bought Micron");
    expect(
      titleOf([
        { verb: "Bought", name: "Pearl" },
        { verb: "Bought", name: "Micron" },
      ]),
    ).toBe("Bought Pearl and Micron");
    expect(
      titleOf(["Pearl", "Micron", "Nvidia", "Gold"].map((name) => ({ verb: "Bought", name }))),
    ).toBe("Bought Pearl and 3 more");
  });

  it("puts a or an before each name as it is said, a ticker's too", () => {
    const said = (names: string[]) => names.map(withArticle);
    expect(
      said(["ETH long", "BTC short", "SOL long", "HYPE long", "XRP short", "NVDA long"]),
    ).toEqual([
      "an ETH long",
      "a BTC short",
      "a SOL long",
      "a HYPE long",
      "an XRP short",
      "an NVDA long",
    ]);
    expect(said(["Arbitrum", "Ink", "Monad", "Unichain", "Aave", "8x long", "1inch"])).toEqual([
      "an Arbitrum",
      "an Ink",
      "a Monad",
      "a Unichain",
      "an Aave",
      "an 8x long",
      "a 1inch",
    ]);
    expect(
      titleOf([
        { verb: "Opened", name: "an ETH short" },
        { verb: "Opened", name: "a BTC long" },
      ]),
    ).toBe("Opened an ETH short and a BTC long");
  });

  it("keeps a receipt to four lines, the rest counted", () => {
    const steps = stepsOf([
      sale("SOL", "3.00"),
      ...["Pearl", "Micron", "Nvidia", "Gold"].map((name) =>
        pick("Bought", name, `Bought ${name}`, "5.00"),
      ),
    ]);
    expect(steps.map(({ text, amountUsd }) => [text, amountUsd])).toEqual([
      ["Sold SOL", "3.00"],
      ["Bought Pearl", "5.00"],
      ["Bought Micron", "5.00"],
      ["2 more moves", "10.00"],
    ]);
  });

  it("signs only money that left their account, as a withdrawal", () => {
    const withdrawal = leg(
      {
        kind: "pick",
        verb: "Withdrew",
        name: "$40",
        step: "Sent to your address",
        money: { flow: "out", usd: "40.00" },
        logo: null,
      },
      { proposalId: null, threadId: null, touches: [] },
    );
    const [item] = activityOf(facts({ legs: [withdrawal] }), null).items;
    expect(item).toMatchObject({
      title: "Withdrew $40",
      subtitle: "Auni, Oct 20 at 7:30pm",
      amount: { usd: "40.00", direction: "out", tone: "neutral" },
    });
  });
});

// On Oct 14 Hyperliquid liquidated Starknet's 193.1 STRK long at $0.07855.
const STRK: Happened = {
  cause: "liquidation",
  market: "STRK",
  side: "sell",
  size: "193.1",
  priceUsd: "0.07855",
  before: "193.1",
  after: "0",
  closedPnlUsd: "-5.256182",
  venueFeeUsd: "0.006825",
};

/** A perp's change at Hyperliquid, named `name`, in words. */
const said = (happened: Happened, name: string, pnlUsd: number, exit?: Exit) =>
  happenedWords(happened, { name, ticker: happened.market }, "Hyperliquid", pnlUsd, exit);

describe("saying what a venue did", () => {
  it("says a liquidation plainly, with what it lost", () => {
    expect(said(STRK, "STRK", -5.256182)).toEqual({
      title: "Hyperliquid closed your STRK long",
      why: "Its price moved against it until the margin behind it ran out.",
      result: "You lost $5.26.",
      fill: "193.1 STRK sold at $0.07855.",
      before: "193.1 STRK long, worth $15.17",
      after: "Closed",
    });
  });

  it("says part of a short closed by auto-deleveraging", () => {
    const words = said(
      { ...STRK, cause: "auto-deleveraging", side: "buy", before: "-300", after: "-100" },
      "STRK",
      2.5,
    );
    expect(words).toMatchObject({
      title: "Hyperliquid closed part of your STRK short",
      result: "You made $2.50.",
      before: "300 STRK short, worth $23.56",
      after: "100 STRK short, worth $7.85",
    });
  });

  it("tells a trade made outside Auni from Auni's own orders filling later", () => {
    const opened = { ...STRK, side: "buy" as const, before: "0", after: "50", closedPnlUsd: "0" };
    expect(said({ ...opened, cause: "trade" }, "Nvidia", 0)).toMatchObject({
      title: "A trade outside Auni opened your Nvidia long",
      result: null,
    });
    expect(said({ ...opened, cause: "limit" }, "Nvidia", 0)).toMatchObject({
      title: "Your limit order opened your Nvidia long",
      why: "A limit order Auni placed earlier filled.",
    });
    expect(said({ ...STRK, cause: "exit" }, "STRK", 3, "take-profit")).toMatchObject({
      title: "Your take-profit closed your STRK long",
      why: "It reached a stop-loss or take-profit price Auni set.",
    });
    // A stop-loss moved past the entry closes at a gain, and is still the stop-loss.
    expect(said({ ...STRK, cause: "exit" }, "STRK", 0.01, "stop-loss")).toMatchObject({
      title: "Your stop-loss closed your STRK long",
    });
    expect(said({ ...STRK, cause: "exit" }, "STRK", -1)).toMatchObject({
      title: "Your stop closed your STRK long",
    });
  });

  it("says a limit Auni placed filling as the limit, even where it shrinks a position another specialist holds", () => {
    // Another specialist's ETH long, and this one's short limit filling against it.
    const shorted = { ...STRK, market: "ETH", side: "sell" as const, before: "3", after: "2" };
    expect(orderOf("short", "sell")).toBe("limit");
    expect(orderOf("short", "buy")).toBe("exit");
    // A change of stops opens nothing: whatever of it fills is a stop.
    expect(orderOf(null, "sell")).toBe("exit");
    expect(said({ ...shorted, cause: orderOf("short", "sell") }, "ETH", 0)).toMatchObject({
      title: "Your limit order closed part of your ETH long",
      why: "A limit order Auni placed earlier filled.",
    });
  });
});

type ArrivalRow = typeof arrivals.$inferSelect;

function deposit(fields: Partial<ArrivalRow> = {}): ArrivalRow {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    chain: "base",
    txHash: "0xdeposit",
    position: "log:1",
    instrument: NETWORKS.base.usdc,
    baseUnits: "250000000",
    decimals: 6,
    usdValue: "250.00",
    symbol: null,
    counterparty: "0x2222222222222222222222222222222222222222",
    kind: "deposit",
    actionId: null,
    at: new Date("2026-10-22T01:00:00Z"),
    block: 1,
    countsFrom: new Date("2026-10-22T01:00:00Z"),
    createdAt: new Date("2026-10-22T01:01:00Z"),
    ...fields,
  };
}

const liquidation = {
  id: "00000000-0000-4000-8000-0000000000f1",
  at: new Date("2026-10-14T09:21:00Z"),
  // Recorded once Auni read the statement, after they last looked.
  recordedAt: new Date("2026-10-23T00:00:00Z"),
  threadId: STARKNET,
  touches: [STARKNET],
  title: "Hyperliquid closed your STRK long",
  amount: { usd: "5.26", direction: "out" as const, tone: "loss" as const },
  logo: { src: "https://app.hyperliquid.xyz/coins/STRK.svg", name: "Starknet" },
  decision: true,
  receipt: {
    by: "Hyperliquid",
    before: "193.1 STRK long, worth $15.17",
    after: "Closed",
    why: "…",
  },
};

describe("unread", () => {
  it("counts what they didn't do, recorded since they last looked, whichever specialist they look at", () => {
    const all = facts({
      legs: pearlCard(),
      outside: [
        liquidation,
        {
          ...liquidation,
          id: "00000000-0000-4000-8000-0000000000f2",
          recordedAt: new Date("2026-10-15T00:00:00Z"),
        },
      ],
      arrivals: [
        deposit(),
        // A first sweep's history: recorded now, but sent long before, which they knew of.
        deposit({
          id: "00000000-0000-4000-8000-0000000000d2",
          txHash: "0xold",
          at: new Date("2026-09-01T00:00:00Z"),
        }),
      ],
    });

    const everything = activityOf(all, null);
    expect(everything.unread).toBe(2);
    expect(everything.items.map((item) => [item.title, item.unread])).toEqual([
      ["Money arrived", true],
      ["Bought Pearl", false],
      ["Hyperliquid closed your STRK long", true],
      ["Hyperliquid closed your STRK long", false],
      ["Money arrived", false],
    ]);
    expect(everything.items[0]).toMatchObject({
      subtitle: "Your wallet, Oct 22 at 12:00pm",
      amount: { usd: "250.00", direction: "in", tone: "gain" },
      receipt: {
        network: "Base",
        moved: [{ amount: "250", symbol: "USDC" }],
        counterparty: "0x2222…2222",
      },
    });

    const starknet = activityOf(all, STARKNET);
    expect(starknet.items.map((item) => item.id)).toEqual([
      liquidation.id,
      "00000000-0000-4000-8000-0000000000f2",
    ]);
    expect(starknet.unread).toBe(2);
    expect(activityOf({ ...all, seenAt: new Date("2026-10-24T00:00:00Z") }, null).unread).toBe(0);
  });
});

describe("when", () => {
  it("says the day and time in their zone, and the year only when it isn't this one", () => {
    expect(when(new Date("2026-10-14T09:21:00Z"), SYDNEY)).toBe("Oct 14 at 8:21pm");
    expect(when(new Date("2025-03-01T00:05:00Z"), "UTC")).toBe("Mar 1, 2025 at 12:05am");
  });
});
