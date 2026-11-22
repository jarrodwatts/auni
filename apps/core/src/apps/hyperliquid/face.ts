import { stockArt, stockIndex, stockName } from "../../money/swaps/stock-index.ts";
import { heldLabel } from "../../money/format.ts";
import type { Holding } from "../../money/portfolio.ts";
import type { HoldingFace, MarketFace } from "../contract.ts";
import about from "./about.ts";
import { tickerOf } from "./keys.ts";

/**
 * A market as a person reads it, and its mark. A HIP-3 market is the stock it tracks, by the
 * ticker after its dex (xyz:NVDA is Nvidia), wearing the stock's mark; only then is the stock
 * catalog read. A main-dex market is crypto whatever stock shares its ticker (STRK is Starknet,
 * not Strategy's preferred, and SUI is not Sun Communities), wearing Hyperliquid's coin art.
 */
export async function perpFace(market: string): Promise<MarketFace> {
  const coin = tickerOf(market);
  const stock = coin === market ? undefined : (await stockIndex()).byTicker.get(coin.toLowerCase());
  return {
    name: stock ? stockName(stock) : coin,
    ticker: coin,
    logoUrl: stock ? stockArt(stock) : `https://app.hyperliquid.xyz/coins/${market}.svg`,
  };
}

/** A position as the portfolio shows it: what it tracks and which way, and its size on Hyperliquid. */
export async function positionFace(holding: Holding): Promise<HoldingFace> {
  const face = await perpFace(holding.instrument);
  const side = holding.short ? "short" : "long";
  return {
    name: `${face.name} ${holding.leverage ? `${holding.leverage}x ${side}` : side}`,
    detail: `${heldLabel(holding.quantity)} ${face.ticker} on ${about.name}`,
    // A coin without any art falls back to the initial on the web.
    logoUrl: face.logoUrl,
  };
}
