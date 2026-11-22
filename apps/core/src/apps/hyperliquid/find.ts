import { matchesTerm } from "../../money/matches.ts";
import { cached } from "../../money/swaps/shared.ts";
import type { Instrument } from "../contract.ts";
import { info } from "./api.ts";
import about from "./about.ts";

/** A search waits this long for a dex's markets. */
const SOURCE_TIMEOUT_MS = 4_000;

interface PerpMarket {
  readonly coin: string;
  readonly markPrice: number;
  readonly openInterestUsd: number;
  readonly volume24hUsd: number;
}

type MetaAndCtxs = [
  { universe: { name: string; isDelisted?: boolean }[] },
  { markPx: string; openInterest: string; dayNtlVlm: string }[],
];

const perpMarkets = cached(30_000, async (): Promise<PerpMarket[]> => {
  const dexes = await Promise.all(
    [{}, { dex: "xyz" }].map((dex) =>
      info<MetaAndCtxs>({ type: "metaAndAssetCtxs", ...dex }, SOURCE_TIMEOUT_MS),
    ),
  );
  return dexes.flatMap(([meta, contexts]) =>
    meta.universe.flatMap((asset, index) => {
      const context = contexts[index];
      if (asset.isDelisted || !context) return [];
      const markPrice = Number(context.markPx);
      return [
        {
          coin: asset.name,
          markPrice,
          openInterestUsd: Number(context.openInterest) * markPrice,
          volume24hUsd: Number(context.dayNtlVlm),
        },
      ];
    }),
  );
});

/** Perps by name or ticker, for find_instruments; a stock's matches its ticker (NVIDIA, NVDA). */
export async function findPerps(
  terms: readonly string[],
  tickers: () => Promise<readonly string[]>,
): Promise<Omit<Instrument, "venue">[]> {
  const [markets, found] = await Promise.all([perpMarkets("all"), tickers()]);
  const wanted = [...terms, ...found];
  return markets
    .filter((market) => wanted.some((term) => matchesTerm(term, market.coin.replace(/^xyz:/u, ""))))
    .map((market) => ({
      kind: "perp",
      tool: "hyperliquid_order",
      name: market.coin.startsWith("xyz:")
        ? `${market.coin.slice(4)} perpetual (trade.xyz)`
        : `${market.coin} perpetual`,
      ticker: market.coin.replace(/^xyz:/u, ""),
      chain: about.id,
      identifier: market.coin,
      price: market.markPrice,
      liquidityUsd: market.openInterestUsd,
      volume24hUsd: market.volume24hUsd,
      logoUrl: `https://app.hyperliquid.xyz/coins/${market.coin}.svg`,
    }));
}
