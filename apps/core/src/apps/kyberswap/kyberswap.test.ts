import { NETWORKS } from "@auni/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetKept } from "../../money/swaps/shared.ts";
import { marketName, quoteKyberSwap } from "./kyberswap.ts";

/** KyberSwap's route through two markets, and its names for the markets on Monad, as it answers. */
function answer(names: "named" | "down") {
  return vi.fn(async (url: string | URL) => {
    const { host, pathname } = new URL(url);
    if (host === "ks-setting.kyberswap.com")
      return names === "down"
        ? new Response("busy", { status: 503 })
        : Response.json({
            data: {
              dexes: [
                { dexId: "kuru-ob-v2", name: "Kuru OB V2" },
                { dexId: "pancake-v3", name: "PancakeSwap V3" },
              ],
            },
          });
    if (pathname.endsWith("/routes"))
      return Response.json({
        data: {
          routeSummary: {
            amountOut: "1000",
            route: [
              [{ exchange: "kuru-ob-v2" }, { exchange: "pancake-v3" }],
              [{ exchange: "kuru-ob-v2" }],
            ],
          },
          routerAddress: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
        },
      });
    throw new Error(`unexpected ${String(url)}`);
  });
}

const request = {
  chain: "monad" as const,
  sellToken: NETWORKS.monad.usdc as `0x${string}`,
  buyToken: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071" as const,
  sellAmount: 3_000_000n,
  slippageBps: 100,
};

beforeEach(() => forgetKept());
afterEach(() => vi.unstubAllGlobals());

describe("the markets a KyberSwap route fills on", () => {
  it("are named as people know them, each once", async () => {
    vi.stubGlobal("fetch", answer("named"));
    expect((await quoteKyberSwap(request)).filledOn).toEqual(["Kuru", "PancakeSwap"]);
  });

  it("go unnamed while KyberSwap's names can't be read, since an id is no name", async () => {
    vi.stubGlobal("fetch", answer("down"));
    expect((await quoteKyberSwap(request)).filledOn).toEqual([]);
  });

  it("drop the version and kind KyberSwap adds to a market's name", () => {
    expect(marketName("Kuru OB V2")).toBe("Kuru");
    expect(marketName("TraderJoe V2.2")).toBe("TraderJoe");
    expect(marketName("Uniswap V4 Clanker")).toBe("Uniswap V4 Clanker");
    expect(marketName("V3")).toBe("V3");
  });
});
