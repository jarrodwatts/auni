import { takesWireSchema } from "@auni/shared";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireOwner } from "../auth/middleware.ts";
import { db } from "../db/client.ts";
import { arrivals, fills, ownerSessions, threads } from "../db/schema.ts";
import { env } from "../env.ts";
import { ownerRouter } from "../routes/owner.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { serve } from "../test/serve.ts";
import { buildPortfolio } from "./books.ts";
import type { Holding } from "./portfolio.ts";
import { takesRouter } from "./routes.ts";

const NVDA = "0x00000000000000000000000000000000000000aa";

/** 15 Nvidia shares in the wallet at $120, bought at $100 each. */
const nvidia: Holding = {
  venue: "wallet",
  chain: "monad",
  instrument: NVDA,
  symbol: "NVDAx",
  quantity: "15",
  decimals: 18,
  usdValue: "1800.00",
  cash: false,
  priceId: null,
  averageCostUsd: "100",
};

/** 0.01 BTC long at 3x, entered at $60,000 (so $200 of margin), now worth $250: $50 made, says the venue. */
const btcLong: Holding = {
  venue: "hyperliquid",
  chain: "hyperliquid",
  instrument: "BTC",
  symbol: "BTC",
  quantity: "0.01",
  decimals: 18,
  usdValue: "250.00",
  cash: false,
  priceId: null,
  leverage: 3,
  averageCostUsd: "60000",
  unrealizedPnlUsd: "50.00",
};

const cash: Holding = {
  venue: "wallet",
  chain: "monad",
  instrument: "0x00000000000000000000000000000000000000cc",
  symbol: "USDC",
  quantity: "500",
  decimals: 6,
  usdValue: "500.00",
  cash: true,
  priceId: null,
};

/** What the wallet and its venues hold in each test. */
const wallet = vi.hoisted(() => ({ holdings: [] as Holding[] }));

vi.mock("./portfolio.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  portfolioNow: () =>
    Promise.resolve(
      buildPortfolio({
        observedAt: new Date(),
        holdings: wallet.holdings,
        onItsWay: [],
        unavailable: [],
        looking: [],
      }),
    ),
}));

// Names, logos and the day's move are holdings.ts's to read; here a holding is shown as it is.
vi.mock("./holdings.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  holdingViews: (held: readonly Holding[]) =>
    Promise.resolve(
      held.map((holding) => ({
        id: `${holding.chain}:${holding.instrument}`,
        name: holding.symbol,
        detail: holding.quantity,
        logoUrl: null,
        usdValue: holding.usdValue ?? "0.00",
        todayChangeUsd: null,
      })),
    ),
}));

const url = serve(express().use("/owner", ownerRouter).use("/takes", requireOwner, takesRouter));

let cookie = "";
beforeEach(async () => {
  await wipe(ownerSessions, threads, fills, arrivals);
  wallet.holdings = [nvidia, btcLong, cash];
  const { mintPairingCode } = await import("../auth/owner.ts");
  const paired = await fetch(url("/owner/pair"), {
    method: "POST",
    headers: { origin: env.WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ code: await mintPairingCode() }),
  });
  cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
});

async function bought(
  threadId: string | null,
  key: Pick<Holding, "chain" | "instrument">,
  quantity: string,
  usdValue: string,
) {
  const action = await insertAction({ status: "done", threadId });
  await db.insert(fills).values({
    actionId: action.id,
    threadId,
    chain: key.chain,
    instrument: key.instrument,
    side: "buy",
    quantity,
    usdValue,
  });
}

const read = async () =>
  takesWireSchema.parse(await (await fetch(url("/takes"), { headers: { cookie } })).json());

describe("GET /takes", () => {
  it("answers only the owner's browser", async () => {
    expect((await fetch(url("/takes"))).status).toBe(401);
  });

  it("gives each take its share of the wallet, worth and made, largest first", async () => {
    const ai = await insertThread({ title: "AI buildout" });
    const btc = await insertThread({ title: "Go long bitcoin" });
    await insertThread({ title: "Just a question" });
    await bought(ai.id, nvidia, "10", "1000.00");
    await bought(btc.id, btcLong, "0.01", "600.00");

    const { takes, loose } = await read();

    expect(takes).toEqual([
      {
        threadId: ai.id,
        title: "AI buildout",
        // 10 of the 15 shares: $1,200, which cost $1,000.
        valueUsd: "1200.00",
        changeUsd: "200.00",
        costUsd: "1000.00",
        holdings: [expect.objectContaining({ name: "NVDAx", usdValue: "1200.00" })],
      },
      {
        threadId: btc.id,
        title: "Go long bitcoin",
        // The margin its entry put up, not the $600 it controls.
        valueUsd: "250.00",
        changeUsd: "50.00",
        costUsd: "200.00",
        holdings: [expect.objectContaining({ name: "BTC", usdValue: "250.00" })],
      },
    ]);
    // The 5 shares no take bought, and never the cash.
    expect(loose).toEqual([expect.objectContaining({ name: "NVDAx", usdValue: "600.00" })]);
  });

  it("says what each holding in a take made, beside what the take made", async () => {
    const ai = await insertThread({ title: "AI buildout" });
    const tesla: Holding = {
      ...nvidia,
      instrument: "0x00000000000000000000000000000000000000bb",
      symbol: "TSLAx",
      quantity: "2",
      usdValue: "500.00",
      averageCostUsd: undefined,
    };
    wallet.holdings = [nvidia, tesla];
    await bought(ai.id, nvidia, "15", "1500.00");
    await bought(ai.id, tesla, "2", "600.00");

    const [take] = (await read()).takes;

    expect(take).toMatchObject({ changeUsd: "200.00", costUsd: "2100.00" });
    expect(take!.holdings).toEqual([
      expect.objectContaining({ name: "NVDAx", changeUsd: "300.00", costUsd: "1500.00" }),
      expect.objectContaining({ name: "TSLAx", changeUsd: "-100.00", costUsd: "600.00" }),
    ]);
  });

  it("caps what takes hold at what the wallet holds, the first to buy first", async () => {
    const first = await insertThread({ title: "First" });
    const second = await insertThread({ title: "Second" });
    await bought(first.id, nvidia, "12", "1200.00");
    await bought(second.id, nvidia, "12", "1200.00");

    const { takes, loose } = await read();

    expect(takes.map(({ title, valueUsd }) => [title, valueUsd])).toEqual([
      ["First", "1440.00"],
      ["Second", "360.00"],
    ]);
    // No share of Nvidia is left over, and the long no take bought is the owner's own.
    expect(loose).toEqual([expect.objectContaining({ name: "BTC" })]);
  });

  it("costs each take what its own fills paid, whatever the owner bought beside it", async () => {
    const low = await insertThread({ title: "Bought low" });
    const high = await insertThread({ title: "Bought high" });
    // 3 shares at $120 now: one each take bought, at $100 and $200, and one bought loose at $90.
    wallet.holdings = [{ ...nvidia, quantity: "3", usdValue: "360.00", averageCostUsd: "130" }];
    await bought(low.id, nvidia, "1", "100.00");
    await bought(high.id, nvidia, "1", "200.00");
    await bought(null, nvidia, "1", "90.00");

    const { takes, loose } = await read();

    expect(
      takes.map(({ title, valueUsd, changeUsd, costUsd }) => [title, valueUsd, changeUsd, costUsd]),
    ).toEqual([
      ["Bought low", "120.00", "20.00", "100.00"],
      ["Bought high", "120.00", "-80.00", "200.00"],
    ]);
    expect(loose).toEqual([expect.objectContaining({ name: "NVDAx", usdValue: "120.00" })]);
  });

  it("puts savings a take bought under it, and the rest of the cash by where it sits", async () => {
    const earning = await insertThread({ title: "Keep my idle cash earning" });
    const aave = {
      venue: "aave",
      chain: "monad",
      instrument: "0x35a73BAcb179d3740395A3ceCc87FF2e581d6042",
      symbol: "aUSDC",
      decimals: 6,
      cash: true,
      priceId: null,
    } as const;
    wallet.holdings = [
      cash,
      { ...aave, quantity: "4100", usdValue: "4100.00" },
      {
        ...cash,
        venue: "hyperliquid",
        chain: "hyperliquid",
        instrument: "USDC",
        quantity: "950.15",
        usdValue: "950.15",
      },
    ];
    await bought(earning.id, aave, "4000", "4000.00");
    // Saved a month ago, it has earned $10; the other $90 of aUSDC came in from an exchange.
    await db.update(fills).set({ createdAt: new Date(Date.now() - 30 * 86_400_000) });
    await db.insert(arrivals).values({
      chain: "monad",
      txHash: "0x01",
      position: "log:0",
      instrument: aave.instrument,
      baseUnits: "90000000",
      decimals: 6,
      usdValue: "90.00",
      symbol: "aUSDC",
      kind: "deposit",
      at: new Date(),
      block: 1,
    });

    const { takes, loose, cash: places } = await read();

    expect(takes).toEqual([
      expect.objectContaining({
        title: "Keep my idle cash earning",
        valueUsd: "4010.00",
        changeUsd: "10.00",
        costUsd: "4000.00",
      }),
    ]);
    // Cash is never a holding of no take's.
    expect(loose).toEqual([]);
    expect(places).toEqual([
      { venue: "wallet", name: "Your wallet", logoUrl: null, savings: false, usdValue: "500.00" },
      expect.objectContaining({
        venue: "hyperliquid",
        name: "Hyperliquid",
        savings: false,
        usdValue: "950.15",
      }),
      expect.objectContaining({ venue: "aave", name: "Aave", savings: true, usdValue: "90.00" }),
    ]);
  });
});
