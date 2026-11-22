import { accountToken, filling } from "../apps/registry.ts";
import { coinName } from "./coins.ts";
import { fillIdentity } from "./fill-key.ts";
import { xStockCatalog } from "./swaps/xstocks.ts";
import type { SolanaToken } from "../apps/contract.ts";
import { solanaTokens } from "./swaps/solana-swap.ts";
import { feedListed } from "./token-feeds.ts";

/**
 * The tokens Auni recognises, whichever wallet holds them: a network's own coin,
 * its USDC and USDT, savings, a tokenized stock in the stock catalog, and
 * on an EVM network one on a token feed's list for it, or on Solana one
 * the Solana route verified or sees real people trade (organicScore above zero).
 * Nothing else is trusted by what it is, whatever its price: anyone can mint a
 * token and price it from a pool they seeded. Whether a token is a person's
 * own is theirs to say (see buckets.ts).
 */

/** What the lists say of one token: whether it is on one, and the symbol and name a listing gives it. */
export interface Listing {
  readonly recognised: boolean;
  /**
   * Its symbol as its listing names it; for one not recognised, its own as
   * the Solana route reads it from the mint, which only names a token that is theirs.
   */
  readonly symbol: string | null;
  /**
   * What a list calls a recognised token ("Tether Gold Tokens"); null for one the code names
   * itself (a coin, cash, a stock), and for any token not recognised, whose makers chose it.
   */
  readonly name: string | null;
}

/**
 * What a list that can't be read now does: "throw", for what mustn't pass a
 * token by on a guess, or "unlisted", taking every token it would list as on
 * none, for what only names them.
 */
export type Unreadable = "throw" | "unlisted";

const UNLISTED: Listing = { recognised: false, symbol: null, name: null };

/**
 * Each of these tokens on `chain`, by fillIdentity, as the lists say. The
 * lists are read lazily and kept, so this costs nothing most times; only
 * while a list it needs has never been read is it `unreadable`.
 */
export async function listings(
  chain: string,
  instruments: readonly string[],
  unreadable: Unreadable = "throw",
): Promise<Map<string, Listing>> {
  const found = new Map<string, Listing>();
  const rest: string[] = [];
  for (const instrument of instruments) {
    const name = registryName(chain, instrument);
    if (name)
      found.set(fillIdentity({ chain, instrument }), {
        recognised: true,
        symbol: name,
        name: null,
      });
    else rest.push(instrument);
  }
  if (rest.length === 0) return found;
  const read = Promise.all([
    xStockCatalog(),
    chain === "solana" ? solanaListings(rest) : listedOn(chain),
  ]);
  const [stocks, listed] = await (unreadable === "throw"
    ? read
    : read.catch((error: unknown) => {
        console.warn(
          `token lists on ${chain} unreadable; taking those asked of as unlisted:`,
          error,
        );
        return [[], () => UNLISTED] as const;
      }));
  const stockAt = new Map(
    stocks.flatMap((stock) =>
      [stock.evmAddress, stock.solanaMint].flatMap((at) =>
        at ? [[at.toLowerCase(), stock.symbol] as const] : [],
      ),
    ),
  );
  for (const instrument of rest) {
    const stock = stockAt.get(instrument.toLowerCase());
    found.set(
      fillIdentity({ chain, instrument }),
      stock ? { recognised: true, symbol: stock, name: null } : listed(instrument),
    );
  }
  return found;
}

/**
 * How a token comes to be recognised, as the agent is told it: on a list, each named by the
 * app that keeps it, verified on Solana's token listing, or a tokenized stock.
 */
export function recognisedHow(): string {
  const lists = filling("tokens").flatMap(({ about, part }) =>
    part.listed ? [`${about.name}'s`] : [],
  );
  return `on ${lists.join(" or ") || "a public token"} list, verified on Solana's token listing, or a tokenized stock`;
}

/**
 * The registry's name for a network's own coin, its USDC and USDT, and the tokens an account
 * keeps in the wallet (a savings token, a vault's shares): the repo vouches for each, so none
 * waits on a public list.
 */
export function registryName(chain: string, instrument: string): string | null {
  return coinName({ chain, instrument }) ?? accountToken({ chain, instrument })?.symbol ?? null;
}

/** On an EVM network, what a token feed's list for it says. */
async function listedOn(chain: string): Promise<(instrument: string) => Listing> {
  const list = await feedListed(chain);
  return (instrument) => {
    const token = list.get(instrument.toLowerCase());
    return token ? { recognised: true, symbol: token.symbol, name: token.name } : UNLISTED;
  };
}

/** On Solana, what the Solana route says of each mint. */
async function solanaListings(wanted: readonly string[]): Promise<(mint: string) => Listing> {
  const tokens = await listedMints(wanted);
  return (mint) => {
    const token = tokens.get(mint);
    if (!token) return UNLISTED;
    const recognised = token.verified || token.organicScore > 0;
    return { recognised, symbol: token.symbol, name: recognised ? token.name : null };
  };
}

/** How long the route's word on a mint stands, so one coming to be traded is recognised within a day. */
const MINT_KEPT_MS = 24 * 60 * 60_000;
/** Mints asked for at once, as many as a route's listing takes in one search. */
const MINTS_PER_SEARCH = 100;

/** What the route last said of each mint, null for one it doesn't know, and when. */
const mints = new Map<string, { readonly at: number; readonly token: SolanaToken | null }>();

/**
 * The route's listing of each mint, each kept a day; those not kept are
 * asked for together. One it can't read now keeps its last answer,
 * and with none it throws.
 */
async function listedMints(
  wanted: readonly string[],
): Promise<ReadonlyMap<string, SolanaToken | null>> {
  const now = Date.now();
  // Anyone can send a mint, so ones long unasked are let go.
  for (const [mint, entry] of mints) if (now - entry.at >= 2 * MINT_KEPT_MS) mints.delete(mint);
  const stale = [...new Set(wanted)].filter((mint) => {
    const entry = mints.get(mint);
    return !entry || now - entry.at >= MINT_KEPT_MS;
  });
  for (let start = 0; start < stale.length; start += MINTS_PER_SEARCH) {
    const batch = stale.slice(start, start + MINTS_PER_SEARCH);
    try {
      const tokens = await solanaTokens(batch);
      for (const mint of batch)
        mints.set(mint, { at: now, token: tokens.find((token) => token.mint === mint) ?? null });
    } catch (error) {
      if (batch.some((mint) => !mints.has(mint))) throw error;
      console.warn("The Solana token listing is unavailable; its last word stands:", error);
    }
  }
  return new Map(wanted.map((mint) => [mint, mints.get(mint)?.token ?? null]));
}
