import { takesWireSchema } from "@auni/shared";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireOwner } from "../auth/middleware.ts";
import { db } from "../db/client.ts";
import { fills, ownerSessions, threads } from "../db/schema.ts";
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

/** 0.01 BTC long at 3x, entered at $60,000 (so $200 of margin), now worth $250. */
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

vi.mock("./portfolio.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  portfolioNow: () =>
    Promise.resolve(
      buildPortfolio({
        observedAt: new Date(),
        holdings: [nvidia, btcLong, cash],
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
  await wipe(ownerSessions, threads, fills);
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
});
