import { z } from "zod";

import { defineTool, result } from "../agent/tool.ts";
import { costTotal } from "./effect.ts";
import { feeLabel } from "./format.ts";
import { matchesTerm } from "./matches.ts";
import { within } from "./swaps/shared.ts";
import { searchSolanaTokens, solanaPrice, solanaTokens } from "./swaps/solana-swap.ts";
import { previewMonadBuy } from "./recipes/stock-trade.ts";
import { findXStock, xStockCatalog, type XStock } from "./swaps/xstocks.ts";
import type { Instrument, SolanaToken } from "../apps/contract.ts";
import type { Reach } from "./recipe.ts";
import { noAddressOn } from "./wallets.ts";
import { offered, filling } from "../apps/registry.ts";

const SOURCE_TIMEOUT_MS = 4_000;
const PER_KIND = 8;
/** The buy each stock found is priced at on Monad: a typical pick. */
const CHECK_USD = 25;
/** A Monad venue answers in under a second; a stock it hasn't priced by now says so. */
const CHECK_TIMEOUT_MS = 2_500;

const input = {
  query: z
    .string()
    .min(1)
    .max(120)
    .describe('A theme or name: "AI chips", "gold", "tennis", "Nvidia".'),
  related: z
    .array(z.string().min(1).max(60))
    .max(6)
    .optional()
    .describe(
      "Names or tickers you expect under the theme (NVIDIA, AMD, TSM). Stocks and perps match names, not themes.",
    ),
};

type FindInput = z.infer<z.ZodObject<typeof input>>;

/** A stock as the search lists it: on Monad first, as stock_trade trades it. */
function stockFromToken(stock: XStock, token: SolanaToken | undefined): Instrument {
  return {
    kind: "stock",
    name: stock.name.replace(/ xStock$/u, ""),
    ticker: stock.ticker,
    venue: "xStocks",
    chain: "monad",
    tool: "stock_trade",
    identifier: stock.symbol,
    price: token?.usdPrice ?? null,
    liquidityUsd: token?.liquidityUsd ?? null,
    volume24hUsd: token?.volume24hUsd ?? null,
    logoUrl: stock.logoUrl,
  };
}

/**
 * What CHECK_USD of `stock` costs on Monad now, at its share's price, from the preview its
 * card would get, so the search and the card never disagree; or what Monad answered.
 */
function monadCheck(stock: XStock): Promise<string> {
  const said = previewMonadBuy(stock, CHECK_USD).then(
    ({ unpriced, effect }) => {
      if (unpriced === "no price") return "trades on Monad, with no price to judge it by";
      const total = costTotal(effect.costs);
      const usual = unpriced === "loses on fill" ? ", more than a normal trade" : "";
      return `$${CHECK_USD} costs ${total > 0 ? feeLabel(total) : "nothing"} to buy${usual}`;
    },
    // A stock no Monad venue sells goes to Solana, whose depth `liquidityUsd` says.
    (error: unknown) =>
      `Monad can't sell it now: ${error instanceof Error ? error.message : error}`,
  );
  return within(said, CHECK_TIMEOUT_MS).catch(
    () => "Monad didn't answer in time; stock_trade asks it again",
  );
}

async function findStocks(terms: readonly string[], reach: Reach): Promise<Instrument[]> {
  const stocks = (await xStockCatalog()).filter((stock) =>
    terms.some((term) =>
      matchesTerm(term, stock.name.replace(/ xStock$/u, ""), stock.ticker, stock.symbol),
    ),
  );
  const mints = stocks
    .flatMap((stock) => (stock.solanaMint ? [stock.solanaMint] : []))
    .slice(0, 50);
  // One that trades on Monad alone has no token on Solana to ask about.
  const tokens = mints.length > 0 ? await solanaTokens(mints).catch(() => null) : [];
  // Without the route's prices, still name the matches; with them, drop the ones nothing trades:
  // on Solana by its depth, while one with a Monad token stays for `checked` to ask Monad.
  if (!tokens)
    return stocks.flatMap((stock) =>
      reach.solana || stock.evmAddress ? [stockFromToken(stock, undefined)] : [],
    );
  const byMint = new Map(tokens.map((token) => [token.mint as string, token]));
  return stocks.flatMap((stock) => {
    const token = stock.solanaMint ? byMint.get(stock.solanaMint) : undefined;
    // A wallet with no Solana key trades a stock on Monad or not at all.
    const onSolana = reach.solana && Boolean(token?.usdPrice && token.liquidityUsd);
    return stock.evmAddress || onSolana ? [stockFromToken(stock, token)] : [];
  });
}

/**
 * A stock candidate with what Monad says of it now, and its share's price rather than its
 * token's last swap: read once a search has its few, so a slow answer never loses one.
 */
async function checked(item: Instrument): Promise<Instrument> {
  if (item.tool !== "stock_trade") return item;
  const stock = await findXStock(item.identifier).catch(() => null);
  if (!stock) return item;
  const [monad, share] = await Promise.all([
    monadCheck(stock),
    stock.solanaMint
      ? within(solanaPrice(stock.solanaMint), CHECK_TIMEOUT_MS).catch(() => null)
      : null,
  ]);
  return { ...item, price: share?.usdPrice ?? item.price, monad };
}

async function findTokens(terms: readonly string[]): Promise<Instrument[]> {
  const results = await Promise.all(terms.slice(0, 3).map((term) => searchSolanaTokens(term)));
  // Listed by the route that searched them.
  const route = filling("solana")[0]?.about.name ?? "Solana";
  return results.flat().map((token) => ({
    kind: token.tags.includes("stocks") ? "stock" : "token",
    name: token.name,
    ticker: token.symbol,
    venue: token.tags.includes("xstocks") ? "xStocks" : route,
    chain: "solana",
    // xStocks trade through stock_trade by symbol, so they dedupe against the catalog search.
    ...(token.tags.includes("xstocks")
      ? { tool: "stock_trade" as const, identifier: token.symbol }
      : { tool: "solana_swap" as const, identifier: token.mint }),
    price: token.usdPrice,
    liquidityUsd: token.liquidityUsd,
    volume24hUsd: token.volume24hUsd,
    logoUrl: token.logoUrl,
  }));
}

/**
 * Every venue in parallel, each capped at a few seconds; a slow or failing venue is reported, not
 * fatal. For a wallet that can't move on Solana, nothing only Solana trades is listed, and it says so.
 */
export async function searchInstruments(search: FindInput, reach: Reach = { solana: true }) {
  const terms = [
    ...new Set(
      [search.query, ...(search.related ?? [])].map((term) => term.trim()).filter(Boolean),
    ),
  ];
  const stocks = findStocks(terms, reach);
  const tokens = reach.solana ? findTokens(terms) : Promise.resolve([]);
  // Perps also match the tickers the stock and token searches turn up (NVIDIA -> NVDA).
  const matchedTickers = async () => {
    const found = await Promise.all(
      [stocks, tokens].map((search) => within(search, SOURCE_TIMEOUT_MS).catch(() => [])),
    );
    return found.flat().map((item) => item.ticker);
  };
  // Each venue that finds what it trades is one source, by its name.
  const sources: [string, Promise<Instrument[]>][] = [
    ["stocks", stocks],
    ...offered().flatMap(({ about, account }): [string, Promise<Instrument[]>][] => {
      if (!account?.find) return [];
      const found = account.find(terms, matchedTickers);
      return [
        [about.name, found.then((items) => items.map((item) => ({ ...item, venue: about.name })))],
      ];
    }),
    ["tokens", tokens],
  ];
  const settled = await Promise.all(
    sources.map(async ([name, search]) => {
      try {
        return { name, items: await within(search, SOURCE_TIMEOUT_MS + 1_500) };
      } catch (error) {
        return {
          name,
          items: [] as Instrument[],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const seen = new Set<string>();
  const candidates = settled.flatMap(({ name, items }) => {
    // Tokens rank by depth, since a thin one can still trade a lot in a day; the rest by volume.
    const rank = (item: Instrument) =>
      name === "tokens" ? (item.liquidityUsd ?? 0) : (item.volume24hUsd ?? item.liquidityUsd ?? 0);
    return [...items]
      .sort((a, b) => rank(b) - rank(a))
      .filter((item) => !seen.has(item.identifier) && seen.add(item.identifier))
      .slice(0, PER_KIND);
  });
  const unavailable = settled.flatMap((source) =>
    "error" in source ? [`${source.name}: ${source.error}`] : [],
  );
  return {
    candidates: await Promise.all(candidates.map(checked)),
    ...(unavailable.length > 0 ? { unavailable } : {}),
    ...(reach.solana ? {} : { note: noAddressOn("Solana") }),
  };
}

/** The search, for a wallet that can move on what `reach` says. */
export const findInstruments = (reach: Reach) =>
  defineTool({
    name: "find_instruments",
    description:
      "Search every venue at once for things to buy on a theme or name: tokenized stocks (xStocks), " +
      "perps (crypto plus stocks and commodities), prediction markets, " +
      "and Solana tokens, deepest first, with their liquidity. Returns plain candidates with price, liquidity or 24h volume, the " +
      "tool that trades each and the identifier that tool takes. A stock shows its share's price, what $25 of it costs to buy on " +
      "Monad right now (as its card would say) or what Monad answered, and its Solana token's " +
      "depth, where stock_trade takes a stock Monad can't sell: many barely trade there. Judge picks " +
      "by that. Partial results are normal when a " +
      "venue is slow. EVM tokens " +
      "aren't searched here, and a coin with its own chain usually trades on them wrapped (Pearl is " +
      "WPRL on Ethereum); the evm-transactions skill finds them.",
    inputSchema: input,
    handler: async (search) => result(JSON.stringify(await searchInstruments(search, reach))),
  });
