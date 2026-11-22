import { getAddress } from "viem";

import { fetchJson, lastGood } from "../../money/swaps/shared.ts";
import type { XStock } from "../../money/swaps/xstocks.ts";

// Backed issues the xStocks, tokenized stocks, each at one CREATE2 address on every EVM chain
// (Monad included) and one mint on Solana. Its public API, with no key, lists them all.

interface BackedAsset {
  readonly name: string;
  readonly symbol: string;
  readonly underlyingSymbol: string;
  readonly logo: string;
  readonly deployments: readonly { readonly address: string; readonly network: string }[];
}

const BACKED_ASSETS = "https://api.backed.fi/api/v2/public/assets";
// The API serves 100 assets a page (about 1,100 in September 2026) and ignores page-size parameters.
const MAX_PAGES = 20;

async function loadCatalog(): Promise<readonly XStock[]> {
  const pages = await Promise.all(
    Array.from({ length: MAX_PAGES }, (_, page) =>
      fetchJson<{ nodes: BackedAsset[] }>(`${BACKED_ASSETS}?page=${page}`, { timeoutMs: 15_000 }),
    ),
  );
  return pages.flatMap((page) =>
    page.nodes.map((asset) => {
      const evm = asset.deployments.find((deployment) => deployment.address.startsWith("0x"));
      return {
        symbol: asset.symbol,
        name: asset.name,
        ticker: asset.underlyingSymbol,
        logoUrl: asset.logo,
        solanaMint:
          asset.deployments.find((deployment) => deployment.network === "Solana")?.address ?? null,
        evmAddress: evm ? getAddress(evm.address) : null,
      };
    }),
  );
}

/**
 * Every xStock it lists, reread every six hours, as it lists new stocks now and then; the
 * last catalog it served answers while a reread fails (see lastGood). Telling an xStock apart
 * is what values it right (see XSTOCK_SHARES in money/chain-holdings.ts), so a failed read is
 * reported, not hidden.
 */
export const stocks = lastGood(loadCatalog, {
  rereadMs: 6 * 60 * 60_000,
  retryMs: 60_000,
  failed: (error) => console.warn("xStock catalog unavailable:", error),
});

interface BackedTrading {
  readonly isTradingHalted?: boolean;
  readonly trading?: {
    readonly isTradingHalted?: boolean;
    readonly openNow?: boolean;
    readonly nextChangeAt?: string;
  };
}

/**
 * What it, the issuer, says of the stock's market when it isn't open, for a trade that
 * couldn't go through on Monad: " Backed lists NVDA's market as closed until Sun, 25 Oct 2026
 * 00:00:00 GMT." Empty while it's open, or when it can't say.
 */
export async function marketNote(stock: XStock): Promise<string> {
  const asset = await fetchJson<BackedTrading>(
    `${BACKED_ASSETS}/${encodeURIComponent(stock.symbol)}`,
    { timeoutMs: 5_000 },
  ).catch(() => null);
  const trading = asset?.trading;
  // It keeps a halt flag in two places, and they don't always agree.
  if (asset?.isTradingHalted || trading?.isTradingHalted)
    return ` Backed lists trading in ${stock.ticker} as halted.`;
  if (trading?.openNow !== false) return "";
  const reopens = Date.parse(trading.nextChangeAt ?? "");
  return Number.isFinite(reopens)
    ? ` Backed lists ${stock.ticker}'s market as closed until ${new Date(reopens).toUTCString()}.`
    : ` Backed lists ${stock.ticker}'s market as closed.`;
}
