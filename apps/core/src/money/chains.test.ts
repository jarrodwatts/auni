import {
  EVM_CHAIN_KEYS,
  CASH_KEYS,
  NETWORK_KEYS,
  NETWORKS,
  proposalWireSchema,
  WITHDRAW_NETWORKS,
} from "@auni/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { env } from "../env.ts";
import {
  ALCHEMY_NETWORKS,
  chainIdOf,
  chainKey,
  chainLabel,
  evmClient,
  publicClient,
  rpcFor,
  solanaRpc,
} from "./chains.ts";
import { coinOf, coinName, isPlainCash } from "./coins.ts";

// What each list read before they were all derived from one registry of networks.
describe("the network registry", () => {
  it("lists the networks core moves money on, EVM ones first", () => {
    const visiting = ["ethereum", "unichain", "ink", "robinhood", "bnb"];
    expect(EVM_CHAIN_KEYS).toEqual(["monad", "base", "arbitrum", "polygon", ...visiting]);
    expect(NETWORK_KEYS).toEqual(["monad", "base", "arbitrum", "polygon", ...visiting, "solana"]);
    // Cash is spent only where it always was; the rest take deposits that go home on a card.
    expect(CASH_KEYS).toEqual(["monad", "base", "arbitrum", "polygon", "solana"]);
    // USDC is named USDC everywhere, but it's Cash only there: elsewhere a priced token.
    expect(isPlainCash("base", NETWORKS.base.usdc)).toBe(true);
    expect(isPlainCash("ink", NETWORKS.ink.usdc)).toBe(false);
    expect(coinName({ chain: "ink", instrument: NETWORKS.ink.usdc })).toBe("USDC");
    // Where Circle issues none, no dollar token is named USDC: USDG is priced by its feed.
    expect(NETWORKS.robinhood.usdc).toBeNull();
    const usdg = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    expect(coinName({ chain: "robinhood", instrument: usdg })).toBeNull();
    expect(isPlainCash("robinhood", usdg)).toBe(false);
    expect(proposalWireSchema.shape.funding.unwrap().shape.chain.options).toEqual([
      "monad",
      "base",
      "arbitrum",
      "polygon",
      "solana",
    ]);
  });

  it("knows each EVM network by its chain id and USDC", () => {
    expect(
      Object.fromEntries(
        EVM_CHAIN_KEYS.map((key) => [key, [NETWORKS[key].viem.id, NETWORKS[key].usdc]]),
      ),
    ).toEqual({
      monad: [143, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"],
      base: [8453, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
      arbitrum: [42161, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
      polygon: [137, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"],
      ethereum: [1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
      unichain: [130, "0x078D782b760474a361dDA0AF3839290b0EF57AD6"],
      ink: [57073, "0x2D270e6886d130D724215A266106e6832161EAEd"],
      robinhood: [4663, null],
      bnb: [56, null],
    });
    expect(NETWORKS.solana.usdc).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(chainIdOf("polygon")).toBe(137);
    expect(chainKey(42161)).toBe("arbitrum");
    expect(chainKey(10)).toBe("eip155:10");
    expect(chainKey(56)).toBe("bnb");
    expect(chainKey(4663)).toBe("robinhood");
    expect(NETWORK_KEYS.map(chainLabel)).toEqual([
      "Monad",
      "Base",
      "Arbitrum",
      "Polygon",
      "Ethereum",
      "Unichain",
      "Ink",
      "Robinhood Chain",
      "BNB Chain",
      "Solana",
    ]);
  });

  it("prices each network's own coin as before", () => {
    expect(
      Object.fromEntries(
        NETWORK_KEYS.map((key) => {
          const { asset, decimals, priceId } = NETWORKS[key].coin;
          return [key, { symbol: asset.symbol, decimals, priceId }];
        }),
      ),
    ).toEqual({
      monad: { symbol: "MON", decimals: 18, priceId: "coingecko:monad" },
      base: { symbol: "ETH", decimals: 18, priceId: "coingecko:ethereum" },
      arbitrum: { symbol: "ETH", decimals: 18, priceId: "coingecko:ethereum" },
      polygon: { symbol: "POL", decimals: 18, priceId: "coingecko:polygon-ecosystem-token" },
      ethereum: { symbol: "ETH", decimals: 18, priceId: "coingecko:ethereum" },
      unichain: { symbol: "ETH", decimals: 18, priceId: "coingecko:ethereum" },
      ink: { symbol: "ETH", decimals: 18, priceId: "coingecko:ethereum" },
      robinhood: { symbol: "ETH", decimals: 18, priceId: "coingecko:ethereum" },
      bnb: { symbol: "BNB", decimals: 18, priceId: "coingecko:binancecoin" },
      solana: { symbol: "SOL", decimals: 9, priceId: "coingecko:solana" },
    });
    expect(NETWORK_KEYS.map((chain) => coinOf({ chain, instrument: "native" })?.name)).toEqual([
      "Monad",
      "Ethereum",
      "Ethereum",
      "Polygon",
      "Ethereum",
      "Ethereum",
      "Ethereum",
      "Ethereum",
      "BNB",
      "Solana",
    ]);
  });

  it("reaches each EVM chain through the same Alchemy network", () => {
    expect(ALCHEMY_NETWORKS).toEqual({
      143: "monad-mainnet",
      8453: "base-mainnet",
      42161: "arb-mainnet",
      137: "polygon-mainnet",
      1: "eth-mainnet",
      10: "opt-mainnet",
      130: "unichain-mainnet",
      57073: "ink-mainnet",
      4663: "robinhood-mainnet",
      56: "bnb-mainnet",
    });
    expect(NETWORKS.solana.alchemy).toBe("solana-mainnet");
  });

  it("withdraws to every network cash is spent on, Base first", () => {
    expect(WITHDRAW_NETWORKS).toEqual(["base", "solana", "arbitrum", "monad", "polygon"]);
    expect([...WITHDRAW_NETWORKS].sort()).toEqual([...CASH_KEYS].sort());
  });
});

describe("Alchemy", () => {
  afterEach(() => vi.restoreAllMocks());

  // An RPC error repeats the URL it asked, and errors are logged: the key goes in a header.
  it("is sent its key in a header, never in a URL an error could repeat", async () => {
    const asked: [string, Headers][] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      asked.push([request.url, request.headers]);
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x1" });
    });
    await publicClient("base").getBlockNumber({ cacheTime: 0 });
    await solanaRpc("getSlot", []);
    expect(asked.map(([url]) => url)).toEqual([
      "https://base-mainnet.g.alchemy.com/v2",
      "https://solana-mainnet.g.alchemy.com/v2",
    ]);
    for (const [, headers] of asked) expect(headers.get("authorization")).toBe("Bearer test");
  });
});

describe("where Auni reaches a chain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    env.ALCHEMY_API_KEY = "test";
    env.RPC_URLS = {};
  });

  it("takes the owner's own RPC alone, then Alchemy with a key, then the chain's public ones", () => {
    env.RPC_URLS = { monad: "http://127.0.0.1:8545" };
    expect(rpcFor("monad")).toEqual({
      source: "own",
      endpoints: [{ url: "http://127.0.0.1:8545" }],
    });
    expect(rpcFor(NETWORKS.base.viem.id)).toMatchObject({
      source: "alchemy",
      endpoints: [{ url: "https://base-mainnet.g.alchemy.com/v2" }],
    });
    env.ALCHEMY_API_KEY = undefined;
    expect(rpcFor("base").endpoints.map(({ url }) => url)).toEqual(NETWORKS.base.rpcs);
    expect(rpcFor("solana")).toEqual({
      source: "public",
      endpoints: [{ url: "https://api.mainnet-beta.solana.com" }],
    });
    // Another EVM chain: viem's public RPC for it.
    expect(rpcFor(10)).toEqual({
      source: "public",
      endpoints: [{ url: "https://mainnet.optimism.io" }],
    });
  });

  it("asks a chain's next public RPC what the first won't answer", async () => {
    env.ALCHEMY_API_KEY = undefined;
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const { url } = new Request(input, init);
      asked.push(url);
      return Response.json(
        url === new URL(NETWORKS.ink.rpcs[0]).href
          ? { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not whitelisted" } }
          : { jsonrpc: "2.0", id: 1, result: "0x10" },
      );
    });
    expect(await evmClient(NETWORKS.ink.viem.id).getBlockNumber({ cacheTime: 0 })).toBe(16n);
    expect(asked).toEqual(NETWORKS.ink.rpcs.map((url) => new URL(url).href));
  });

  it("disables off-chain CCIP-Read lookups so resolvers cannot make core dial arbitrary URLs", () => {
    expect(evmClient(1).ccipRead).toBe(false);
  });
});
