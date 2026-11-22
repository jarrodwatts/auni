import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetKept } from "../../money/swaps/shared.ts";
import { listing, logo, prices } from "./tokens.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  forgetKept();
});

const WPRL = "0xd20cd2fa0e9ae2f3f2b8edfbfabaaba6d8ae9bd0";

function answering(answer: (url: string) => Response): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return answer(url);
    }),
  );
  return urls;
}

const listed = () =>
  Response.json({
    address: WPRL,
    symbol: "WPRL",
    name: "Wrapped PRL",
    decimals: 18,
    priceUSD: "0.0421",
    logoURI: "https://static.example/wprl.png",
  });

describe("LI.FI's token list", () => {
  it("says what a token is by core's name for its chain, once in ten minutes", async () => {
    const urls = answering(listed);
    const wanted = { address: WPRL, symbol: "WPRL", name: "Wrapped PRL", decimals: 18 };
    expect(await listing("ethereum", WPRL)).toEqual({ ...wanted, usdPrice: 0.0421 });
    expect(await listing("eip155:1", WPRL)).toEqual({ ...wanted, usdPrice: 0.0421 });
    expect(await logo("ethereum", WPRL)).toBe("https://static.example/wprl.png");
    expect(urls).toEqual([`https://li.quest/v1/token?chain=1&token=${WPRL}`]);
  });

  it("lists a token with no price as unpriced, and has no price for it", async () => {
    answering(() => Response.json({ address: WPRL, symbol: "WPRL", name: "W", decimals: 18 }));
    expect((await listing("monad", WPRL))?.usdPrice).toBeNull();
    expect((await prices([`monad:${WPRL}`])).size).toBe(0);
  });

  it("answers null for a token it doesn't list, and throws when it can't be read", async () => {
    answering(() => new Response('{"message":"Unknown token"}', { status: 400 }));
    expect(await listing("monad", WPRL)).toBeNull();
    expect(await logo("monad", WPRL)).toBeNull();
    forgetKept();
    answering(() => new Response("down", { status: 502 }));
    await expect(listing("monad", WPRL)).rejects.toThrow("li.quest answered 502");
    await expect(prices([`monad:${WPRL}`])).rejects.toThrow("li.quest answered 502");
  });

  it("prices only what names an EVM token now, and asks about nothing else", async () => {
    const urls = answering(listed);
    const ids = [`monad:${WPRL}`, `eip155:43114:${WPRL}`, "coingecko:solana", "solana:So111"];
    expect([...(await prices(ids))]).toEqual([
      [`monad:${WPRL}`, { price: 0.0421 }],
      [`eip155:43114:${WPRL}`, { price: 0.0421 }],
    ]);
    expect(urls.toSorted()).toEqual([
      `https://li.quest/v1/token?chain=143&token=${WPRL}`,
      `https://li.quest/v1/token?chain=43114&token=${WPRL}`,
    ]);
    // It keeps no past price, and Solana is no chain of its list.
    expect((await prices(ids, new Date(0))).size).toBe(0);
    expect(await logo("solana", "So111")).toBeNull();
    expect(urls).toHaveLength(2);
  });
});
