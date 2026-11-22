import {
  EVM_CHAIN_KEYS,
  NETWORKS,
  portfolioWireSchema,
  withdrawCashWireSchema,
} from "@auni/shared";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  actions,
  arrivalCursors,
  arrivals,
  fills,
  otherTokens,
  valueSnapshots,
} from "../db/schema.ts";
import { serve } from "../test/serve.ts";
import { wipe } from "../test/db.ts";
import { portfolioRouter } from "./routes.ts";
import { forgetKept } from "./swaps/shared.ts";
import { sweepNetwork } from "./sweep.ts";
import { withdrawalsRouter } from "./withdrawal-routes.ts";

// The staging test wallet, brought into a brand-new Auni with nothing else done (November 2026):
// its reads on every chain, at Polymarket, Aave and Hyperliquid, recorded once from the public
// RPCs and services (RECORD=1, see test/recorded.ts) and played back through the real readers.
const { FILE, OWNER } = vi.hoisted(() => ({
  FILE: new URL("./fixtures/brought-wallet.json", import.meta.url).pathname,
  OWNER: "0xDB1b977140C41f774cdD070ccc380FDcA9304575",
}));

vi.mock("./chains.ts", async (o) => (await import("../test/recorded.ts")).chains(await o(), FILE));
vi.mock("./wallets.ts", async (o) => ({
  ...(await o<object>()),
  walletAddresses: async () => ({ evm: OWNER, solana: null }),
}));
// A holding's move today, which isn't what this test reads, is none.
vi.mock("./history.ts", async (o) => ({
  ...(await o<object>()),
  readPaths: async () => new Map(),
}));
// What the token feeds said: each price, each chain's token list and the stock catalog, the
// lists cut to what the wallet held (see save).
vi.mock("./token-feeds.ts", async (o) => {
  const real = await o<typeof import("./token-feeds.ts")>();
  const { kept } = await import("../test/recorded.ts");
  return {
    ...real,
    feedPrices: (ids: readonly string[], at?: Date) =>
      new Map(
        ids.map((id) => [
          id,
          kept(
            FILE,
            `price ${id}`,
            async () => (await real.feedPrices([id], at).get(id)) ?? null,
          ).then((price) => price ?? undefined),
        ]),
      ),
    feedListed: async (chain: string) =>
      new Map(await kept(FILE, `listed ${chain}`, async () => [...(await real.feedListed(chain))])),
    feedStocks: () => kept(FILE, "stocks", real.feedStocks),
  };
});
// Nothing moved in or out of the wallet while it was read: the sweep's logs list nothing.
vi.mock("./evm-history.ts", async (o) => ({
  ...(await o<object>()),
  transferLogs: async (_c: string, _w: string, _s: string, _from: number, to: number) => ({
    logs: [],
    through: to,
  }),
  coinDeposits: async (_c: string, _w: string, _from: number, to: number) => ({
    txs: [],
    through: to,
  }),
}));
// The sweeps run here, one network at a time, not in the background as a screen asks.
vi.mock("./sweep.ts", async (o) => ({ ...(await o<object>()), sweepSoon: () => undefined }));

/** Every chain's USDC and USDT, which a first look asks for whatever a list says. */
const CASH_TOKENS = new Set(
  EVM_CHAIN_KEYS.flatMap((chain) =>
    [NETWORKS[chain].usdc, NETWORKS[chain].usdt].flatMap((token) => token?.toLowerCase() ?? []),
  ),
);

const url = serve(
  express().use("/portfolio", portfolioRouter).use("/withdrawals", withdrawalsRouter),
);

const get = async (path: string): Promise<unknown> => (await fetch(url(path))).json();

beforeAll(async () => {
  await wipe(actions, fills, arrivals, arrivalCursors, otherTokens, valueSnapshots);
  const { recordedFetch } = await import("../test/recorded.ts");
  const local = globalThis.fetch;
  const outside = recordedFetch(FILE, [
    "data-api.polymarket.com",
    "gamma-api.polymarket.com",
    "clob.polymarket.com",
    "api.hyperliquid.xyz",
  ]);
  // The test's own requests reach its server; every other is a service's, as recorded.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith("http://127.0.0.1")
      ? local(input, init)
      : outside(input, init),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const { save } = await import("../test/recorded.ts");
  // Each list is cut to the tokens the wallet holds, and the rest of each list's reads go too.
  save(FILE, ({ rpc, http, kept }) => {
    const tokenOf = (key: string) => (key.includes(",balanceof,") ? key.split(",")[1]! : null);
    const held = new Set(
      Object.entries(rpc).flatMap(([key, { ok, result }]) =>
        ok && result !== 0n && tokenOf(key) ? [tokenOf(key)!] : [],
      ),
    );
    const listed = (name: string) => name.startsWith("listed ") || name === "stocks";
    const token = (entry: unknown) =>
      (Array.isArray(entry)
        ? entry[0]
        : ((entry as { evmAddress?: string }).evmAddress ?? "")) as string;
    const cut = Object.fromEntries(
      Object.entries(kept).map(([name, list]) => [
        name,
        listed(name)
          ? (list as unknown[]).filter((entry) => held.has(token(entry).toLowerCase()))
          : list,
      ]),
    );
    // A token on a list the wallet holds none of, which only the list's reads asked of.
    const dropped = new Set(
      Object.entries(kept)
        .filter(([name]) => listed(name))
        .flatMap(([, list]) => (list as unknown[]).map((entry) => token(entry).toLowerCase()))
        .filter((one) => !held.has(one) && !CASH_TOKENS.has(one)),
    );
    return {
      // Only the wallet's own balances: another's (Polymarket's deposit wallet) is no list's.
      rpc: Object.fromEntries(
        Object.entries(rpc).filter(
          ([key]) =>
            !(dropped.has(key.split(",")[1] ?? "") && key.includes(`,[${OWNER.toLowerCase()}],`)),
        ),
      ),
      // A price history asked from now back is never asked the same again.
      http: Object.fromEntries(
        Object.entries(http).filter(([key]) => !/startTime|startTs/u.test(key)),
      ),
      kept: cut,
    };
  });
});

// Recording reads every chain's whole token list from public RPCs, and checks softly, so it
// reads all a test would though a figure has moved since the last recording.
const LONG = { timeout: process.env.RECORD === "1" ? 600_000 : 30_000 };

const portfolio = async () => portfolioWireSchema.parse(await get("/portfolio"));

describe("a wallet brought in with money already in it", () => {
  it(
    "has made nothing from the first look on, says it is still looking, and counts POL once",
    LONG,
    async () => {
      // Before any sweep the portfolio reads what it always reads: each chain's coin and USDC
      // where cash is spent, savings, and every app's account. All of it was there already.
      // Live, this read said made +$2.64.
      const first = await portfolio();
      expect.soft(first.totalUsd).toBe("14.99");
      expect.soft(first.madeUsd).toBe("0.00");
      expect.soft(first.looking).toEqual([...EVM_CHAIN_KEYS]);

      // The first sweep of each network finds the tokens the wallet held there (NVIDIA, WMON...),
      // and the look is made. Live, this read said made +$1.47: the app accounts' holdings.
      for (const chain of EVM_CHAIN_KEYS) await sweepNetwork(chain, OWNER);
      forgetKept();
      const swept = await portfolio();
      expect.soft(swept.looking).toEqual([]);
      expect.soft(swept.totalUsd).toBe("35.30");
      expect.soft(swept.madeUsd).toBe("0.00");
      // Polygon's coin is POL, read as the chain's own coin and as the token at 0x...1010.
      const names = swept.holdings.map(({ name }) => name);
      expect.soft(names.filter((name) => /^(polygon|pol)$/iu.test(name))).toEqual(["Polygon"]);
      expect.soft(names).toContain("NVIDIA");
    },
  );

  it(
    "calls the same money cash in the portfolio and in Withdraw, and says where it is",
    LONG,
    async () => {
      forgetKept();
      const [shown, cash] = await Promise.all([
        portfolio(),
        get("/withdrawals/cash").then((body) => withdrawCashWireSchema.parse(body)),
      ]);
      // Live, the portfolio said $15.19 of cash where Withdraw said $14.60: its wallet's USDC.
      expect.soft(cash.cashUsd).toBe(shown.cashUsd);
      expect.soft(cash).toMatchObject({
        cashUsd: "12.87",
        walletUsd: "8.70",
        elsewhere: [
          { name: "Hyperliquid", usdValue: "3.63" },
          { name: "Aave", usdValue: "0.49" },
          { name: "Polymarket", usdValue: "0.05" },
        ],
      });
    },
  );
});
