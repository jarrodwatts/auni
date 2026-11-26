import { setTimeout as sleep } from "node:timers/promises";

import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, arrivals, otherTokens, valueSnapshots } from "../db/schema.ts";
import { insertAction, wipe } from "../test/db.ts";
import { seeTokens } from "./buckets.ts";
import { fillIdentity } from "./fill-key.ts";
import {
  portfolioNow,
  readFrom,
  readPortfolio,
  readPortfolioShared,
  type Holding,
  type Portfolio,
} from "./portfolio.ts";
import { readStands, saveReading } from "./readings.ts";
import { forgetKept } from "./swaps/shared.ts";

beforeEach(() => wipe(actions, valueSnapshots, arrivals, otherTokens));

/** NVIDIA at $180 and BTC's mark at $100,000, as the shared feeds read them. */
vi.mock(import("./history.ts"), async (original) => ({
  ...(await original()),
  livePrices: vi.fn(
    async () =>
      new Map([
        ["token:monad:0xc845b2894dbddd03858fd2d643b4ef725fe0849d", 180],
        ["hyperliquid:BTC", 100_000],
      ]),
  ),
}));

/** No wallet to read balances from, but an EVM address its moves on their way are checked by. */
vi.mock(import("./wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: vi.fn(async () => ({ evm: null, solana: null })),
  evmAddress: vi.fn(async () => "0x00000000000000000000000000000000000000a1"),
}));

const MINUTE = 60_000;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE);

const USDC: Holding = {
  venue: "wallet",
  chain: "monad",
  instrument: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  symbol: "USDC",
  quantity: "30",
  decimals: 6,
  usdValue: "30.00",
  cash: true,
  priceId: null,
};
const NVIDIA: Holding = {
  venue: "wallet",
  chain: "monad",
  instrument: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d",
  symbol: "NVDAx",
  quantity: "0.5",
  decimals: 18,
  usdValue: "90.00",
  cash: false,
  priceId: "monad:0xc845b2894dbddd03858fd2d643b4ef725fe0849d",
  averageCostUsd: "175",
};
const SHORT_BTC: Holding = {
  venue: "hyperliquid",
  chain: "hyperliquid",
  instrument: "BTC",
  symbol: "BTC",
  quantity: "0.0001",
  decimals: 18,
  usdValue: "10.00",
  cash: false,
  priceId: null,
  short: true,
  leverage: 3,
  averageCostUsd: "104000",
};

/** A whole read begun just now: $130 across cash and two holdings. */
function read(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    observedAt: new Date().toISOString(),
    totalUsd: "130.00",
    unavailable: [],
    looking: [],
    holdings: [USDC, NVIDIA, SHORT_BTC],
    assets: { usdValue: "100.00", holdings: [NVIDIA, SHORT_BTC] },
    cash: { usdValue: "30.00", holdings: [USDC] },
    onTheWay: { usdValue: "0.00", moves: [] },
    ...overrides,
  };
}

async function readingAt(takenAt: Date) {
  await db.insert(valueSnapshots).values({ usdValue: "1.00", takenAt });
}

const readings = () => db.select().from(valueSnapshots).orderBy(asc(valueSnapshots.takenAt));

describe("saveReading", () => {
  it("keeps the total with what it held, only what prices it again", async () => {
    const portfolio = read();

    expect(await saveReading(portfolio)).toBe(true);

    const rows = await readings();
    expect(rows).toHaveLength(1);
    const [total] = rows;
    expect(total).toMatchObject({ usdValue: "130.00", cashUsd: "30.00" });
    expect(total?.takenAt.toISOString()).toBe(portfolio.observedAt);
    expect(total?.holdings).toEqual([
      {
        chain: "monad",
        instrument: USDC.instrument,
        priceId: null,
        quantity: "30",
        decimals: 6,
        usdValue: "30.00",
        cash: true,
      },
      {
        chain: "monad",
        instrument: NVIDIA.instrument,
        priceId: NVIDIA.priceId,
        quantity: "0.5",
        decimals: 18,
        usdValue: "90.00",
        cash: false,
        price: 180,
      },
      {
        chain: "hyperliquid",
        instrument: "BTC",
        priceId: null,
        quantity: "0.0001",
        decimals: 18,
        usdValue: "10.00",
        cash: false,
        short: true,
        price: 100_000,
      },
    ]);
  });

  it("keeps nothing of a read missing a source, which would show as a dip", async () => {
    expect(await saveReading(read({ unavailable: ["hyperliquid"] }))).toBe(false);
    expect(await readings()).toEqual([]);
  });

  it("keeps nothing while a move runs, or settled too lately for the read to show it", async () => {
    const running = await insertAction({ status: "running", startedAt: minutesAgo(1) });
    expect(await saveReading(read())).toBe(false);

    await db
      .update(actions)
      .set({ status: "done", phase: null, updatedAt: minutesAgo(1) })
      .where(eq(actions.id, running.id));
    expect(await saveReading(read())).toBe(false);

    await db
      .update(actions)
      .set({ updatedAt: minutesAgo(3) })
      .where(eq(actions.id, running.id));
    expect(await saveReading(read())).toBe(true);
  });

  it("keeps one past a move still running long after any recipe would have finished", async () => {
    // Left running for a person once its money moved unrecorded (see reconcileStuckActions).
    await insertAction({ status: "running", startedAt: minutesAgo(31) });
    expect(await saveReading(read())).toBe(true);
  });

  it("keeps one every 15 minutes, sooner only once an action has finished since the last", async () => {
    await readingAt(minutesAgo(10));
    await insertAction({ status: "done", updatedAt: minutesAgo(12) });
    expect(await saveReading(read())).toBe(false);

    // A buy that landed after the last reading changed what is held.
    await insertAction({ status: "done", updatedAt: minutesAgo(5) });
    expect(await saveReading(read())).toBe(true);
  });

  it("keeps one sooner once money has landed since the last, when the read can show it", async () => {
    await readingAt(minutesAgo(10));
    let position = 0;
    const deposit = (recorded: Date, usdValue: string | null = "50.00") =>
      db.insert(arrivals).values({
        chain: "base",
        txHash: "0xabc",
        position: `log:${position++}`,
        instrument: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        baseUnits: "50000000",
        decimals: 6,
        usdValue,
        kind: "deposit",
        at: recorded,
        block: 1,
        createdAt: recorded,
      });
    // Recorded a moment ago: the read may not show it yet.
    await deposit(minutesAgo(1));
    expect(await saveReading(read())).toBe(false);

    // A token with no price changes no value, and nor does dust under a cent.
    await db.delete(arrivals);
    await deposit(minutesAgo(5), null);
    await deposit(minutesAgo(5), "0.00");
    expect(await saveReading(read())).toBe(false);
    await deposit(minutesAgo(5));
    expect(await saveReading(read())).toBe(true);
  });

  it("waits on money recorded just now, however long ago it landed", async () => {
    await readingAt(minutesAgo(16));
    // A token sent in half an hour ago, which a read leaves out until its arrival is recorded.
    const arrived = await db
      .insert(arrivals)
      .values({
        chain: "base",
        txHash: "0xabc",
        position: "log:0",
        instrument: "0x514910771af9ca656af840dff83e8264ecf986ca",
        baseUnits: "5000000000000000000",
        decimals: 18,
        usdValue: "75.00",
        kind: "deposit",
        at: minutesAgo(30),
        block: 1,
      })
      .returning();
    expect(await saveReading(read())).toBe(false);

    await db
      .update(arrivals)
      .set({ createdAt: minutesAgo(5) })
      .where(eq(arrivals.id, arrived[0]!.id));
    expect(await saveReading(read())).toBe(true);
  });

  it("keeps one of two reads kept at once", async () => {
    const portfolio = read();
    const kept = await Promise.all([saveReading(portfolio), saveReading(portfolio)]);
    expect(kept.sort()).toEqual([false, true]);
    expect(await readings()).toHaveLength(1);
  });
});

describe("readStands", () => {
  const readAgo = (minutes: number, unavailable: string[] = []) =>
    read({ observedAt: minutesAgo(minutes).toISOString(), unavailable });

  it("lets a whole read stand for 15 minutes, and one missing a source for 2", async () => {
    expect(await readStands(readAgo(14))).toBe(true);
    expect(await readStands(readAgo(16))).toBe(false);
    expect(await readStands(readAgo(1, ["hyperliquid"]))).toBe(true);
    expect(await readStands(readAgo(3, ["hyperliquid"]))).toBe(false);
  });

  it("lets no read stand once a move runs", async () => {
    await insertAction({ status: "running", startedAt: minutesAgo(1) });
    expect(await readStands(readAgo(1, ["hyperliquid"]))).toBe(false);
  });

  // The demo's clock stands still, so a move it ran finished at the very moment of every read
  // after it, and Money went on showing the cash it had spent (2026-11-26).
  it("lets no read stand that began the instant a move finished", async () => {
    const at = minutesAgo(5);
    await insertAction({ status: "done", updatedAt: at });
    expect(await readStands(read({ observedAt: at.toISOString() }))).toBe(false);
  });

  it("lets no read stand once they add a token, which it left out", async () => {
    const token = "0x5555555555555555555555555555555555555555";
    await seeTokens(db, "base", [token]);
    expect(await readStands(readAgo(5))).toBe(true);
    await db.update(otherTokens).set({ keptAt: new Date(), keptUsd: "40.00", keptBlock: 1 });
    expect(await readStands(readAgo(5))).toBe(false);
  });
});

describe("portfolioNow", () => {
  beforeEach(() => forgetKept());

  it("shares a live read among the screens asking within seconds of it", async () => {
    const first = await portfolioNow();
    expect((await portfolioNow()).observedAt).toBe(first.observedAt);
  });

  it("reads again once a move has finished since that read began, however young it is", async () => {
    const before = await portfolioNow();
    await sleep(5);
    // A move still running leaves the read shared: what it will have done isn't known yet.
    const move = await insertAction({ status: "running", startedAt: new Date() });
    expect((await portfolioNow()).observedAt).toBe(before.observedAt);
    await db
      .update(actions)
      .set({ status: "done", phase: null, updatedAt: new Date() })
      .where(eq(actions.id, move.id));
    await sleep(5);
    const after = await portfolioNow();
    expect(Date.parse(after.observedAt)).toBeGreaterThan(Date.parse(before.observedAt));
    // And that read is the one shared from then on.
    expect((await portfolioNow()).observedAt).toBe(after.observedAt);
  });

  it("gives a proposal's check of the cash the same read, never one from before a move finished", async () => {
    const before = await readPortfolioShared();
    expect((await portfolioNow()).observedAt).toBe(before.observedAt);
    await sleep(5);
    await insertAction({ status: "done", updatedAt: new Date() });
    await sleep(5);
    const after = await readPortfolioShared();
    expect(Date.parse(after.observedAt)).toBeGreaterThan(Date.parse(before.observedAt));
  });
});

describe("readFrom", () => {
  it("reads a Solana token from when it was kept, whatever the case of its mint", async () => {
    const mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    await db.insert(otherTokens).values({
      chain: "solana",
      instrument: mint,
      keptAt: new Date(),
      keptUsd: "40.00",
      keptBlock: 1,
    });
    const [kept] = await db.select().from(otherTokens);
    const read = await readFrom("solana", minutesAgo(10), [mint]);
    expect(read.get(fillIdentity({ chain: "solana", instrument: mint }))).toEqual(kept!.keptAt);
  });
});

describe("readPortfolio", () => {
  it("counts a bridge on its way only until its money lands, never beside the balance it landed in", async () => {
    const bridge = (deposit: string) =>
      insertAction({
        tool: "bridge_usdc",
        amountUsd: "12.49",
        input: { from_chain: "1", to_chain: "monad", amount: "12.49" },
        phase: "landing",
        run: { lands: "$12.40 on Monad" },
        txs: [{ chain: "eip155:1", hash: deposit }],
        startedAt: minutesAgo(1),
      });
    const landed = await bridge("0xd1");
    const sailing = await bridge("0xd2");
    // Across filled the first seconds ago, before action-execute's next look at it.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      Response.json(
        String(url).includes("depositTxnRef=0xd1")
          ? { status: "filled", fillTxnRef: "0xf1" }
          : { status: "pending" },
      ),
    );

    const portfolio = await readPortfolio();

    expect(portfolio.onTheWay).toEqual({
      usdValue: "12.49",
      moves: [{ actionId: sailing.id, lands: "$12.40 on Monad", usdValue: "12.49" }],
    });
    // Its watch finishes it, waking its thread as it does.
    const [watched] = await db.select().from(actions).where(eq(actions.id, landed.id));
    expect(watched?.status).toBe("running");
  });
});
