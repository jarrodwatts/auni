import { knownAsset } from "@auni/shared";

import { xStockCatalog, type XStock } from "./xstocks.ts";

/**
 * xStocks by the token addresses they are deployed at (Solana mint, EVM
 * address), and by the ticker of the company they track, for a stock named
 * from a list Auni trusts; lowercased, and empty while no catalog has ever
 * loaded. Never by xStock symbol, which can be another company's ticker
 * (VRTx is Vertiv's xStock, VRTX is Vertex's ticker).
 */
export interface StockIndex {
  readonly byAddress: ReadonlyMap<string, XStock>;
  readonly byTicker: ReadonlyMap<string, XStock>;
}

export async function stockIndex(): Promise<StockIndex> {
  const stocks = await xStockCatalog().catch(() => []);
  const byAddress = new Map<string, XStock>();
  const byTicker = new Map<string, XStock>();
  for (const stock of stocks) {
    for (const key of [stock.solanaMint, stock.evmAddress]) {
      if (key) byAddress.set(key.toLowerCase(), stock);
    }
    byTicker.set(stock.ticker.toLowerCase(), stock);
  }
  return { byAddress, byTicker };
}

/** The logo for a stock named by its ticker, never a token's own symbol. */
export async function stockLogo(ticker: string): Promise<string | null> {
  const stock = (await stockIndex()).byTicker.get(ticker.toLowerCase());
  return stock ? stockArt(stock) : null;
}

/** A stock as people name it: "Nvidia", not "Nvidia xStock". */
export function stockName(stock: XStock): string {
  return stock.name.replace(/ xStock$/u, "");
}

/** The crisp mark Auni ships for a stock people know best, else its listing's artwork. */
export function stockArt(stock: XStock): string {
  return (knownAsset(stock.ticker) ?? knownAsset(stockName(stock)))?.logoUrl ?? stock.logoUrl;
}
