import { NETWORKS } from "@auni/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SolanaToken } from "../apps/contract.ts";

const LINK = "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196";
const SPAM = "0x3333333333333333333333333333333333333333";
const NVDAX = "0x2d1f7226bd1f780af6b9a49dcc0ae00e8df4bdee";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const FRESH = "Fresh1111111111111111111111111111111111111";
const SCAM = "Scam11111111111111111111111111111111111111";

vi.mock("./swaps/xstocks.ts", () => ({
  xStockCatalog: vi.fn(async () => [
    {
      symbol: "NVDAx",
      name: "NVIDIA xStock",
      ticker: "NVDA",
      logoUrl: "",
      solanaMint: null,
      evmAddress: "0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE",
    },
  ]),
}));
// The Solana route verified BONK, sees real trading in one launched today, and none in a scam.
vi.mock("./swaps/solana-swap.ts", () => ({
  solanaTokens: vi.fn(async (mints: readonly string[]) => {
    const token = (mint: string, symbol: string, verified: boolean, organicScore: number) =>
      ({ mint, symbol, name: `${symbol} token`, verified, organicScore }) as unknown as SolanaToken;
    return [
      token(BONK, "Bonk", true, 90),
      token(FRESH, "FRESH", false, 12),
      token(SCAM, "USDC", false, 0),
    ].filter(({ mint }) => mints.includes(mint));
  }),
}));

/** CoinGecko's list for Base lists LINK; each read of it is counted, and `down` fails it. */
let listReads = 0;
let down = false;

beforeEach(() => {
  listReads = 0;
  down = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!url.startsWith("https://tokens.coingecko.com/base/"))
        throw new Error(`unexpected ${url}`);
      listReads += 1;
      if (down) return new Response("busy", { status: 503 });
      return Response.json({ tokens: [{ address: LINK, symbol: "LINK", name: "Chainlink" }] });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Its first import loads every app through the registry, which on a busy machine takes
// seconds: done here, as the file loads, it never counts against a test's time limit. Each test
// then takes a fresh copy (load), which runs the apps again but reads none from disk.
await import("./recognised.ts");

/** A fresh module each test, so no list is kept from the last. */
async function load() {
  vi.resetModules();
  return import("./recognised.ts");
}

describe("listings", () => {
  it("recognises a network's own coin, its USDC and USDT, and Aave savings without asking anyone", async () => {
    const { listings } = await load();
    const found = await listings("arbitrum", [
      "native",
      NETWORKS.arbitrum.usdc,
      NETWORKS.arbitrum.usdt,
      "0x724dc807b04555b71ed48a6896b6F41593b8C637",
    ]);
    expect([...found.values()]).toEqual([
      { recognised: true, symbol: "ETH", name: null },
      { recognised: true, symbol: "USDC", name: null },
      { recognised: true, symbol: "USDT", name: null },
      { recognised: true, symbol: "aUSDC", name: null },
    ]);
    expect(listReads).toBe(0);
  });

  it("recognises a token on CoinGecko's list for its network and a tokenized stock, and nothing else", async () => {
    const { listings } = await load();
    const found = await listings("base", [LINK.toUpperCase().replace("0X", "0x"), NVDAX, SPAM]);
    expect([...found.values()]).toEqual([
      // What the list calls it comes with it; a stock is named by the catalog, not here.
      { recognised: true, symbol: "LINK", name: "Chainlink" },
      { recognised: true, symbol: "NVDAx", name: null },
      { recognised: false, symbol: null, name: null },
    ]);
    // Read once, and kept.
    await listings("base", [SPAM]);
    expect(listReads).toBe(1);
  });

  it("keeps the last list it read when CoinGecko can't be read again, and reads it a day later", async () => {
    const { listings } = await load();
    await listings("base", [LINK]);
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000);
    down = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await listings("base", [LINK])).get(`base:${LINK}`)?.recognised).toBe(true);
    expect(listReads).toBe(2);
  });

  it("throws while it has never read the list it needs", async () => {
    down = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { listings } = await load();
    await expect(listings("base", [SPAM])).rejects.toThrow();
  });

  it("takes what a list it can't read would list as on none, for what only names tokens", async () => {
    down = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { listings } = await load();
    const found = await listings("base", [NETWORKS.base.usdc, LINK], "unlisted");
    expect([...found.values()]).toEqual([
      { recognised: true, symbol: "USDC", name: null },
      { recognised: false, symbol: null, name: null },
    ]);
  });

  it("recognises a Solana token Jupiter verified or sees really traded, never one by its name", async () => {
    const { listings } = await load();
    const found = await listings("solana", [
      BONK,
      FRESH,
      SCAM,
      "Unknown11111111111111111111111111111111111",
    ]);
    expect([...found.values()]).toEqual([
      { recognised: true, symbol: "Bonk", name: "Bonk token" },
      { recognised: true, symbol: "FRESH", name: "FRESH token" },
      // Its own name, which names it only once it's theirs, and never as what it is.
      { recognised: false, symbol: "USDC", name: null },
      { recognised: false, symbol: null, name: null },
    ]);
  });
});
