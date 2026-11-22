import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetKept } from "../../money/swaps/shared.ts";
import { listed, logo } from "./coingecko.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  forgetKept();
});

const TOKEN = "0x6C0AeceeDc55c9d55d8B99216a670D85330941c3";

// Its list is what Auni recognises a token by, which money/recognised.test.ts proves through
// the registry: read once, kept a day, the last one standing while a reread fails.
describe("CoinGecko", () => {
  it("finds a token's artwork by its own name for the chain", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return Response.json(
          url.endsWith("/asset_platforms")
            ? [
                { id: "ethereum", chain_identifier: 1 },
                { id: "solana", chain_identifier: null },
              ]
            : { image: { large: "https://coin-images.coingecko.com/prl.png" } },
        );
      }),
    );
    expect(await logo("ethereum", TOKEN)).toBe("https://coin-images.coingecko.com/prl.png");
    expect(await logo("eip155:1", TOKEN)).toBe("https://coin-images.coingecko.com/prl.png");
    expect(urls).toEqual([
      "https://api.coingecko.com/api/v3/asset_platforms",
      `https://api.coingecko.com/api/v3/coins/ethereum/contract/${TOKEN.toLowerCase()}`,
      `https://api.coingecko.com/api/v3/coins/ethereum/contract/${TOKEN.toLowerCase()}`,
    ]);
    // A chain it has no name for, and one that is no EVM chain, have no artwork to ask for.
    expect(await logo("eip155:999999", TOKEN)).toBeNull();
    expect(await logo("solana", "So11111111111111111111111111111111111111112")).toBeNull();
    expect(urls).toHaveLength(3);
  });

  it("has no artwork while it can't be read, and no list for a network it names none for", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("busy", { status: 503 })),
    );
    expect(await logo("ethereum", TOKEN)).toBeNull();
    expect((await listed("solana")).size).toBe(0);
    expect((await listed("eip155:43114")).size).toBe(0);
  });
});
