import { ETHEREUM } from "@auni/shared";
import { describe, expect, it, vi } from "vitest";

import { holdingFaces, holdingViews } from "./holdings.ts";
import type { Holding } from "./portfolio.ts";
import type { XStock } from "./swaps/xstocks.ts";

const stock = (ticker: string, name: string): XStock => ({
  symbol: `${ticker}x`,
  name: `${name} xStock`,
  ticker,
  logoUrl: `https://example.com/${ticker}.png`,
  solanaMint: null,
  evmAddress: null,
});

vi.mock(import("./swaps/xstocks.ts"), async (original) => ({
  ...(await original()),
  // STRK and SUI are stocks as well as crypto, as they are in the live catalog.
  xStockCatalog: vi.fn(async () => [
    stock("STRK", "Strategy PP Fixed"),
    stock("SUI", "Sun Communities"),
    stock("NVDA", "NVIDIA"),
  ]),
}));

// The wallet pays its own fees on every chain unless a test says a sponsor does.
const sponsor = vi.hoisted(() => ({ sponsored: false }));
vi.mock(import("./wallets.ts"), async (original) => ({
  ...(await original()),
  paysOwnGas: async () => !sponsor.sponsored,
}));

const perp = (instrument: string): Holding => ({
  venue: "hyperliquid",
  chain: "hyperliquid",
  instrument,
  symbol: instrument,
  quantity: "193.1",
  decimals: 6,
  usdValue: "6.77",
  cash: false,
  priceId: null,
  leverage: 3,
});

describe("holdingFaces", () => {
  it("names a main-dex perp as the crypto it is, not a stock sharing its ticker", async () => {
    const [strk, sui] = await holdingFaces([perp("STRK"), perp("SUI")]);
    expect(strk).toMatchObject({
      name: "STRK 3x long",
      detail: "193.1 STRK on Hyperliquid",
      logoUrl: "https://app.hyperliquid.xyz/coins/STRK.svg",
    });
    expect(sui?.name).toBe("SUI 3x long");
  });

  it("names a HIP-3 perp as the stock it tracks", async () => {
    const [strk, nvda] = await holdingFaces([perp("xyz:STRK"), perp("xyz:NVDA")]);
    expect(strk).toMatchObject({
      name: "Strategy PP Fixed 3x long",
      logoUrl: "https://example.com/STRK.png",
    });
    expect(nvda?.name).toBe("NVIDIA 3x long");
  });
});

const wallet = (chain: Holding["chain"], symbol: string, usdValue: string): Holding => ({
  venue: "wallet",
  chain,
  instrument: "native",
  symbol,
  quantity: "0.0003",
  decimals: 18,
  usdValue,
  cash: false,
  priceId: null,
});

// A wallet token's logo is looked up online; these tests stay offline: no token feed a logo is
// looked for in lists any of them. CoinGecko's list for Monad lists Tether Gold, as the live one
// does, its symbol in capitals.
const TETHER_GOLD = "0x01bff41798a0bcf287b996046ca68b395dbc1071";
const VAULT = "0x00000000000000000000000000000000000a17ea";
const GOLD_TOKEN = "0x00000000000000000000000000000000000901d7";
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string | URL) =>
    String(url) === "https://tokens.coingecko.com/monad/all.json"
      ? Response.json({
          tokens: [
            { address: TETHER_GOLD, symbol: "XAUT0", name: "Tether Gold Tokens" },
            { address: VAULT, symbol: "AVLT", name: "Altura Vault Tokens" },
            { address: GOLD_TOKEN, symbol: "GLDT", name: "Gold Token" },
          ],
        })
      : Response.json([]),
  ),
);

describe("holdingViews", () => {
  it("names cash orders hold apart from Cash, by the app holding it, with no move today", async () => {
    const held: Holding = {
      venue: "hyperliquid",
      chain: "hyperliquid",
      instrument: "USDC",
      symbol: "USDC",
      quantity: "3.54",
      decimals: 6,
      usdValue: "3.54",
      cash: true,
      heldForOrders: true,
      priceId: null,
    };
    const [view] = await holdingViews([held], Date.now(), []);
    expect(view).toMatchObject({
      name: "Held for orders",
      detail: "Waiting on Hyperliquid",
      logoUrl: expect.stringContaining("hyperliquid"),
      usdValue: "3.54",
      todayChangeUsd: "0.00",
    });
  });

  it("says where each is when one coin is held on two chains", async () => {
    const views = await holdingViews(
      [wallet("eip155:1", "ETH", "0.86"), wallet("eip155:10", "ETH", "0.48")],
      Date.now(),
      [],
    );
    expect(views.map((view) => view.name)).toEqual([
      "Ethereum on Ethereum",
      "Ethereum on OP Mainnet",
    ]);
  });

  // Real use showed two tiles both named "Monad": MON, and the WMON a wrap made.
  it("names a coin wrapped as a token apart from the coin, and a bridged one as the coin", async () => {
    const wrapped = {
      ...wallet("monad", "WMON", "0.21"),
      instrument: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A",
    };
    const bridged = {
      ...wallet("monad", "WETH", "3.00"),
      instrument: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242",
    };
    const views = await holdingViews(
      [wallet("monad", "MON", "1.10"), wrapped, bridged],
      Date.now(),
      [],
    );
    expect(views.map(({ name, detail }) => [name, detail])).toEqual([
      ["Ethereum", "0.0003 ETH"],
      ["Monad", "0.0003 MON for network fees"],
      ["Wrapped Monad", "0.0003 WMON"],
    ]);
  });

  // Real use showed a new chat offering "Is my $0.01 of MON worth keeping?" of the coin that
  // pays every fee there.
  it("says the coin the wallet pays a chain's fees in is for that, and only where nobody pays them for it", async () => {
    const [mon] = await holdingViews([wallet("monad", "MON", "0.01")], Date.now(), []);
    expect(mon).toMatchObject({ name: "Monad", detail: "0.0003 MON for network fees" });
    sponsor.sponsored = true;
    const [paid] = await holdingViews([wallet("monad", "MON", "0.01")], Date.now(), []);
    expect(paid).toMatchObject({ name: "Monad", detail: "0.0003 MON" });
    sponsor.sponsored = false;
    // Held at a venue, it is the venue's to say.
    const [away] = await holdingViews(
      [{ ...wallet("monad", "MON", "0.01"), venue: "hyperliquid" }],
      Date.now(),
      [],
    );
    expect(away?.detail).not.toContain("for network fees");
  });

  it("shows a chain's own coin as its coin wherever it's held", async () => {
    const [op] = await holdingViews([wallet("eip155:10", "ETH", "0.48")], Date.now(), []);
    expect(op).toMatchObject({ name: "Ethereum", detail: "0.0003 ETH", logoUrl: ETHEREUM.logoUrl });
  });

  it("leaves out a crumb worth under a cent", async () => {
    const views = await holdingViews(
      [wallet("eip155:1", "ETH", "0.86"), wallet("eip155:137", "USDT", "0.00")],
      Date.now(),
      [],
    );
    expect(views.map((view) => view.name)).toEqual(["Ethereum"]);
  });

  it("keeps a token of theirs with no price, as a buy whose token lost its price, or while prices can't be read", async () => {
    const unpriced: Holding = {
      ...wallet("base", "TRENCH", "0"),
      instrument: "0x7777777777777777777777777777777777777777",
      usdValue: null,
    };
    const views = await holdingViews([wallet("eip155:1", "ETH", "0.86"), unpriced], Date.now(), []);
    expect(views.map((view) => view.name)).toEqual(["Ethereum", "TRENCH"]);
  });

  // Real use read "Bought Tether Gold Tokens": CoinGecko's list names XAUt0, and a few other
  // tokens, in the plural. "Gold Token" is a token of gold's, not gold, so it keeps its word.
  it("names a token its list recognises as the list calls it, in the singular, with its symbol under it", async () => {
    const gold: Holding = {
      ...wallet("monad", "XAUt0", "3.00"),
      instrument: TETHER_GOLD,
      quantity: "0.000775",
      decimals: 6,
    };
    const vault: Holding = { ...wallet("monad", "AVLT", "2.00"), instrument: VAULT };
    const goldToken: Holding = { ...wallet("monad", "GLDT", "1.00"), instrument: GOLD_TOKEN };
    const views = await holdingViews([gold, vault, goldToken], Date.now(), []);
    expect(views.map(({ name, detail }) => [name, detail])).toEqual([
      ["Tether Gold", "0.000775 XAUt0"],
      ["Altura Vault", "0.0003 AVLT"],
      ["Gold Token", "0.0003 GLDT"],
    ]);
  });
});
