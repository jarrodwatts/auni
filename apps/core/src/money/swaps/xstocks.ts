import type { Address } from "viem";

import { feedMarketNote, feedStocks } from "../token-feeds.ts";

/** A tokenized stock, as the catalog of its issuer lists it (see Tokens.stocks). */
export interface XStock {
  /** Token symbol, e.g. NVDAx. */
  readonly symbol: string;
  readonly name: string;
  /** Underlying ticker, e.g. NVDA. */
  readonly ticker: string;
  readonly logoUrl: string;
  readonly solanaMint: string | null;
  /** Its one address on every EVM chain, Monad included. */
  readonly evmAddress: Address | null;
}

/**
 * Every tokenized stock a token feed catalogs. The feed keeps its last catalog while a reread
 * fails, so this fails only while none has ever loaded. Telling an xStock apart is what values
 * it right (see XSTOCK_SHARES in chain-holdings.ts), so a failed read is never an empty list.
 */
export const xStockCatalog = feedStocks;

/**
 * Every xStock's address on an EVM chain, lowercased: each is at one address on all of them.
 * Fails while no catalog has loaded.
 */
export async function evmXStocks(): Promise<ReadonlySet<string>> {
  const stocks = await xStockCatalog();
  return new Set(
    stocks.flatMap((stock) => (stock.evmAddress ? [stock.evmAddress.toLowerCase()] : [])),
  );
}

/** NVDA, NVDAx, or "Nvidia" resolve to the same xStock. */
export async function findXStock(query: string): Promise<XStock> {
  const match = stockNamed(await xStockCatalog(), query);
  if (!match) throw new Error(`"${query}" is not in the xStocks catalog.`);
  return match;
}

/**
 * The xStock `query` names: its ticker or symbol as written, then either in any case, then the
 * start of its company's name. Case counts first, since an xStock's symbol is its ticker and a
 * lowercase x, which can be another company's ticker: VRTx is Vertiv's, VRTX is Vertex's.
 */
export function stockNamed(stocks: readonly XStock[], query: string): XStock | undefined {
  const wanted = query.trim();
  const lower = wanted.toLowerCase();
  return (
    stocks.find((stock) => stock.symbol === wanted || stock.ticker === wanted) ??
    stocks.find((stock) => stock.ticker.toLowerCase() === lower) ??
    stocks.find((stock) => stock.symbol.toLowerCase() === lower) ??
    (lower ? stocks.find((stock) => stock.name.toLowerCase().startsWith(lower)) : undefined)
  );
}

/**
 * What the stock's issuer says of its market when it isn't open, for a trade that couldn't go
 * through on Monad, as a sentence that follows another. Empty while it's open, or when nobody
 * can say.
 */
export const marketNote = feedMarketNote;
