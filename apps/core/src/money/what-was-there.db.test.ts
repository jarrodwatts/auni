import { NETWORKS } from "@auni/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, arrivals, fills, otherTokens } from "../db/schema.ts";
import { insertAction, wipe } from "../test/db.ts";
import { madeUsd, walletFlows } from "./made.ts";
import { countBeforeTrading, countWhatWasThere } from "./other-tokens.ts";
import { readFrom } from "./portfolio.ts";
import { insertFills } from "./record.ts";

// A wallet brought in from elsewhere, holding ETH and USDT on Ethereum, where Auni spends no
// cash, and LINK, which a feed lists, before Auni ever swept the network.
const OWNER = "0x1111111111111111111111111111111111111111";
const { USDT, LINK, SPAM, NVDAX, POL, HELD, COIN_HELD } = vi.hoisted(() => {
  const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  // NVIDIA's tokenized stock on Monad.
  const NVDAX = "0x4444444444444444444444444444444444444444";
  // Polygon's own coin as a token, whose balance is the coin's (RAN, November 2026).
  const POL = "0x0000000000000000000000000000000000001010";
  const POL_HELD = 2_261_201_412_642_508_705n;
  return {
    USDT,
    LINK: "0x514910771af9ca656af840dff83e8264ecf986ca",
    SPAM: "0x3333333333333333333333333333333333333333",
    NVDAX,
    POL,
    /** What the wallet holds of each token, by chain id and lowercased address. */
    HELD: {
      1: { [USDT]: 2_500_000n },
      143: { [NVDAX]: 121_700n },
      137: { [POL]: POL_HELD },
    } as Readonly<Record<number, Readonly<Record<string, bigint>>>>,
    /** And of each chain's own coin: a little ETH on Ethereum, 67 MON on Monad, 2.26 POL. */
    COIN_HELD: { 1: 193_665_133_820_946n, 143: 67n * 10n ** 18n, 137: POL_HELD } as Record<
      number,
      bigint
    >,
  };
});

vi.mock("./wallets.ts", async (o) => (await import("../test/chain.ts")).wallets(await o()));
vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmClient: (id: number) => ({
    id,
    getBlockNumber: async () => 100n,
    getBalance: async () => COIN_HELD[id] ?? 0n,
    multicall: async ({ contracts }: { contracts: { address: string }[] }) =>
      contracts.map(({ address }) => ({
        status: "success",
        result: HELD[id]?.[address.toLowerCase()] ?? 0n,
      })),
  }),
}));
vi.mock("./chain-holdings.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readTokens: vi.fn(async (client: { id: number }, _owner: string, tokens: string[]) =>
    tokens.map((token) => ({
      token,
      balance: HELD[client.id]?.[token.toLowerCase()] ?? 0n,
      decimals: 6,
      symbol: "USDT",
    })),
  ),
}));
// A feed lists LINK and USDT on Ethereum; the spam is on no list, so is never asked for.
vi.mock("./token-feeds.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  feedListed: async () =>
    new Map([
      [LINK, "LINK"],
      [USDT, "USDT"],
      [POL, "POL"],
    ]),
}));
vi.mock("./swaps/xstocks.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmXStocks: async () => new Set([NVDAX]),
}));
vi.mock("./history.ts", async (o) =>
  (await import("../test/chain.ts")).history(await o(), {
    "coingecko:ethereum": { price: 2_000 },
    [`ethereum:${USDT}`]: { price: 1 },
    "coingecko:monad": { price: 0.02 },
    "coingecko:polygon-ecosystem-token": { price: 0.084 },
    [`polygon:${POL}`]: { price: 0.084 },
    [`monad:${NVDAX}`]: { price: 180 },
  }),
);

beforeEach(async () => {
  await wipe(otherTokens, arrivals, actions, fills);
  COIN_HELD[1] = 193_665_133_820_946n;
  COIN_HELD[143] = 67n * 10n ** 18n;
});

/** Auni trades a chain's coin, Monad's unless told: the wallet holds `coin` of it after, for `usd` of cash the other way. */
async function trade(
  side: "buy" | "sell",
  quantity: string,
  usd: string,
  coin: bigint,
  chain: "monad" | "ethereum" = "monad",
) {
  await countBeforeTrading([{ chain, instrument: "native" }]);
  const action = await insertAction({ tool: "stock_trade", input: { side } });
  await db.transaction((tx) =>
    insertFills(tx, action.id, [
      { chain, instrument: "native", side, quantity, usdValue: usd, specialistId: null },
    ]),
  );
  COIN_HELD[NETWORKS[chain].viem.id] = coin * 10n ** 18n;
}

describe("countWhatWasThere", () => {
  it("counts what a wallet held on a network before Auni first swept it, as money put in", async () => {
    await countWhatWasThere("ethereum", OWNER);
    const kept = await db
      .select({ instrument: otherTokens.instrument, keptUsd: otherTokens.keptUsd })
      .from(otherTokens);
    expect(kept.toSorted((a, b) => a.instrument.localeCompare(b.instrument))).toEqual([
      // 0.000193665 ETH at $2,000, to the cent below, and 2.5 USDT.
      { instrument: USDT, keptUsd: "2.50" },
      { instrument: "native", keptUsd: "0.38" },
    ]);
    expect(kept.map(({ instrument }) => instrument)).not.toContain(SPAM);
    expect(kept.map(({ instrument }) => instrument)).not.toContain(LINK);
  });

  // A brand-new Auni given a brought wallet's key read $18.58, then $40.48 once its first sweep
  // found NVIDIA shares and the rest, and said it had made $2.05 throughout, having made nothing.
  it("counts what a wallet held where Auni spends cash as put in, its coin too, so made reads nothing", async () => {
    expect(NETWORKS.monad.cash).toBe(true);
    await countWhatWasThere("monad", OWNER);
    // 67 MON at 2 cents is $1.34, and 0.1217 NVDAx at $180 is $21.90.
    expect(
      (await walletFlows()).map(({ key, usd }) => ({ key, usd })).toSorted((a, b) => a.usd - b.usd),
    ).toEqual([
      { key: "monad:native", usd: 1.34 },
      { key: `monad:${NVDAX}`, usd: 21.9 },
    ]);
    const flows = await walletFlows();
    expect(madeUsd(1.34 + 21.9, 0, flows)).toBe("0.00");
    // A reading from before the sweep held the MON, read from the start, and no NVDAx yet.
    expect(madeUsd(1.34, 0, flows, Date.now() - 60_000)).toBe("0.00");
  });

  // A chain's first look is its first sweep's, and a sweep can fail for hours (Polygon's logs
  // timed out every sweep, November 2026) while Auni trades there all the same. Sold then, 10
  // of 67 MON for $0.20 read as $0.20 made for good: the look counted only the 57 left.
  it.each([
    // 57 MON is $1.14, and the $0.20 it sold for is plain cash.
    { traded: "sold", side: "sell" as const, mon: 57n, value: 1.14 + 21.9 + 0.2, cash: 0.2 },
    // 77 MON is $1.54, bought with $0.20 of cash that is gone.
    { traded: "bought", side: "buy" as const, mon: 77n, value: 1.54 + 21.9, cash: 0 },
  ])(
    "counts the coin as it was before Auni $traded some, when that came before the first sweep",
    async ({ side, mon, value, cash }) => {
      await trade(side, "10", "0.20", mon);
      await countWhatWasThere("monad", OWNER);
      expect(madeUsd(value, cash, await walletFlows())).toBe("0.00");
      // The first sweep looks again each time it fails before it ends: nothing counts twice.
      await countWhatWasThere("monad", OWNER);
      expect(madeUsd(value, cash, await walletFlows())).toBe("0.00");
    },
  );

  it("counts coin bought into a wallet that held none once, though the first sweep looks after", async () => {
    COIN_HELD[143] = 0n;
    await trade("buy", "10", "0.20", 10n);
    await countWhatWasThere("monad", OWNER);
    // 10 MON is $0.20, all of it bought: the look must not put it in a second time.
    expect(madeUsd(0.2 + 21.9, 0, await walletFlows())).toBe("0.00");
  });

  it("looks once where it found no coin, so coin Auni buys before the sweep ends isn't put in again", async () => {
    COIN_HELD[143] = 0n;
    // The sweep's look, whose sweep then failed reading logs, so it looks again next time.
    await countWhatWasThere("monad", OWNER);
    await trade("buy", "10", "0.20", 10n);
    await countWhatWasThere("monad", OWNER);
    expect(madeUsd(0.2 + 21.9, 0, await walletFlows())).toBe("0.00");
  });

  it("puts coin Auni bought in once where no cash is spent too, though the first sweep looks after", async () => {
    COIN_HELD[1] = 0n;
    await countWhatWasThere("ethereum", OWNER);
    // 1 ETH bought for $2,000, read from that fill on; the sweep's look, made again, adds nothing.
    await trade("buy", "1", "2000", 1n, "ethereum");
    await countWhatWasThere("ethereum", OWNER);
    const coin = (await walletFlows()).filter(({ key }) => key === "ethereum:native");
    expect(coin.map(({ usd }) => usd)).toEqual([2_000]);
  });

  // A brought wallet listed "Polygon $0.19" and "POL $0.19": the coin, and the same coin as a
  // token at 0x...1010, which a token list names.
  it("counts Polygon's coin once, though a list names it as a token too", async () => {
    await countWhatWasThere("polygon", OWNER);
    expect(await db.select({ instrument: otherTokens.instrument }).from(otherTokens)).toEqual([
      { instrument: "native" },
    ]);
  });

  // readFrom decides which tokens readPortfolio reads on a network, from when.
  it("is what the portfolio then reads on that network, where Auni spends no cash", async () => {
    expect(NETWORKS.ethereum.cash).toBe(false);
    expect([...(await readFrom("ethereum", new Date(), ["native", USDT, LINK])).keys()]).toEqual(
      [],
    );
    await countWhatWasThere("ethereum", OWNER);
    expect([...(await readFrom("ethereum", new Date(), ["native", USDT, LINK])).keys()]).toEqual([
      "ethereum:native",
      `ethereum:${USDT}`,
    ]);
  });
});
