import { afterEach, describe, expect, it, vi } from "vitest";

import { logo } from "./dexscreener.ts";

afterEach(() => vi.unstubAllGlobals());

const TOKEN = "0x6c0aeceeDc55c9d55d8B99216a670D85330941c3";

function pairs(listed: unknown[]) {
  const fetch = vi.fn(async (_url: string) => Response.json(listed));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("DexScreener", () => {
  it("takes a token's art from its own side of a pair, under its own name for the chain", async () => {
    const fetch = pairs([
      // A pair it quotes carries the other token's artwork.
      {
        baseToken: { address: "0x1111111111111111111111111111111111111111" },
        info: { imageUrl: "https://cdn.dexscreener.com/other.png" },
      },
      {
        baseToken: { address: TOKEN.toLowerCase() },
        info: { imageUrl: "https://cdn.dexscreener.com/prl.png" },
      },
    ]);
    expect(await logo("eip155:1", TOKEN)).toBe("https://cdn.dexscreener.com/prl.png");
    expect(await logo("monad", TOKEN)).toBe("https://cdn.dexscreener.com/prl.png");
    expect(await logo("solana", "So111")).toBeNull();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `https://api.dexscreener.com/tokens/v1/ethereum/${TOKEN}`,
      `https://api.dexscreener.com/tokens/v1/monad/${TOKEN}`,
      "https://api.dexscreener.com/tokens/v1/solana/So111",
    ]);
  });

  it("has none for a chain it doesn't list, and asks for none", async () => {
    const fetch = pairs([]);
    expect(await logo("eip155:43114", TOKEN)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
