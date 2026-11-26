import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { gainOf, holdingsByThread } from "../../money/books.ts";
import { formatUnits } from "../../money/usd.ts";
import { hyperliquidFreeCents, readPosition } from "./account.ts";
import { info } from "./api.ts";
import { readHyperliquid } from "./holdings.ts";
import type { Market } from "./markets.ts";

const USER = "0x3a01d0be0cf4978b652889c44f34b059be0658db";

/** Hyperliquid's answers to the account read in one state (fixtures/account, each says its source). */
interface Answers {
  readonly userAbstraction: string;
  readonly spotClearinghouseState: unknown;
  readonly clearinghouseState: unknown;
}

const fixture = (name: string): Answers =>
  (
    JSON.parse(readFileSync(new URL(`fixtures/account/${name}.json`, import.meta.url), "utf8")) as {
      answers: Answers;
    }
  ).answers;

let answers: Answers;

vi.mock(import("./api.ts"), async (original) => ({
  ...(await original()),
  info: vi.fn(async (body: { readonly type: string }) => {
    if (body.type === "perpDexs") return [null];
    return answers[body.type as keyof Answers];
  }) as never,
}));

vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  tradedMarkets: vi.fn(async () => []),
}));

beforeEach(() => {
  vi.mocked(info).mockClear();
});

const market = (name: string) => ({ name, dex: "" }) as Market;

/**
 * Each state as Hyperliquid answered for it, and what every reader must make of it: the cash
 * free to spend, the cash waiting orders hold, and each open position by what closing it frees,
 * all in cents. Together they are the account's value: spot's USDC total, since every account
 * here is unified.
 */
const STATES = [
  { name: "neither", value: "7.25305", free: 725n, onOrders: 0n, positions: [] },
  // $3.55 held for a $11 order at 3x is still the owner's: the total must not drop by it.
  { name: "resting-order", value: "4.474772", free: 92n, onOrders: 354n, positions: [] },
  {
    name: "open-position",
    value: "45.966468",
    free: 3_589n,
    onOrders: 0n,
    positions: [["AAVE", 1_006n]],
  },
  // What the orders hold is theirs, never added to the positions beside them.
  {
    name: "both",
    value: "2575.89520025",
    free: 134_524n,
    onOrders: 71_405n,
    positions: [
      ["ARB", 42_643n],
      ["MON", 9_015n],
    ],
  },
  // A cross position holding the whole balance is worth all of it, and none of it is free.
  {
    name: "open-cross",
    value: "36.417454",
    free: 0n,
    onOrders: 0n,
    positions: [["ETH", 3_641n]],
  },
] as const;

const cents = (usd: string) => BigInt(Math.round(Number(usd) * 100));

describe.each(STATES)("an account with $name", ({ name, value, free, onOrders, positions }) => {
  beforeEach(() => {
    answers = fixture(name);
  });

  it("is read in the portfolio as free cash, cash held for orders, and positions", async () => {
    const holdings = await readHyperliquid(USER);
    const cash = holdings.filter((holding) => holding.cash && !holding.heldForOrders);
    const held = holdings.filter((holding) => holding.heldForOrders);
    expect(cash.map((holding) => holding.baseUnits / 10_000n)).toEqual([free]);
    expect(held.every((holding) => holding.cash)).toBe(true);
    expect(held.reduce((sum, holding) => sum + holding.baseUnits / 10_000n, 0n)).toBe(onOrders);
    expect(
      holdings
        .filter((holding) => !holding.cash)
        .map((holding) => [holding.instrument, cents(holding.usdValue!)]),
    ).toEqual(positions);
    // All of it adds up to the account's value, short only of the part of a cent each rounds down.
    const total = free + onOrders + positions.reduce((sum, [, worth]) => sum + worth, 0n);
    expect(BigInt(Math.floor(Number(value) * 100)) - total).toBeGreaterThanOrEqual(0n);
    expect(BigInt(Math.floor(Number(value) * 100)) - total).toBeLessThanOrEqual(
      BigInt(2 + positions.length),
    );
  });

  it("offers only the free cash to spend or withdraw", async () => {
    expect(await hyperliquidFreeCents(USER)).toBe(free);
  });

  it("values each position on its card as the portfolio does", async () => {
    for (const [coin, worth] of positions)
      expect(cents(String((await readPosition(USER, market(coin)))!.valueUsd))).toBe(worth);
    expect(await readPosition(USER, market("BTC"))).toBeNull();
  });
});

describe("what each position made", () => {
  beforeEach(() => {
    answers = fixture("both");
  });

  it("is what Hyperliquid says, a losing ARB long and a winning MON short, under the take that opened it", async () => {
    const positions = (await readHyperliquid(USER))
      .filter((holding) => !holding.cash)
      .map(({ baseUnits, pricedUnits: _, ...holding }) => ({
        ...holding,
        venue: "hyperliquid",
        quantity: formatUnits(baseUnits, holding.decimals),
        usdValue: holding.usdValue ?? null,
      }));
    const opened = (threadId: string, instrument: string, side: "buy" | "sell", quantity: string) =>
      ({ threadId, chain: "hyperliquid", instrument, side, quantity, usdValue: "1.00" }) as const;
    const { threads } = holdingsByThread(positions, [
      opened("arb", "ARB", "buy", "29902.4"),
      opened("mon", "MON", "sell", "26686"),
    ]);
    const gain = (threadId: string) => gainOf(threads.get(threadId)![0]!);
    // ARB: $426.44 of margin with funding and margin added, $122.42 down by Hyperliquid, on the
    // $441.33 its entry put up (29,902.4 at $0.14759 over 10x): -27.7%, as Hyperliquid's own
    // return on equity says, where value less margin would say -$14.90.
    expect(gain("arb")).toEqual({ costCents: 44_133n, changeCents: -12_242n });
    // MON: short 26,686 from $0.016864 at 5x ($90.01), up $0.22.
    expect(gain("mon")).toEqual({ costCents: 9_001n, changeCents: 22n });
  });
});
