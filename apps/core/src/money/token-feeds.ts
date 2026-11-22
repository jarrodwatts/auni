import { NETWORKS, servableImage } from "@auni/shared";

import type { ListedToken, TokenListing, Tokens } from "../apps/contract.ts";
import type { PricePoint, TokenPrice } from "./history.ts";
import type { XStock } from "./swaps/xstocks.ts";

/**
 * What the public feeds say of tokens: core's door to the apps that fill the tokens role
 * (see Tokens in apps/contract.ts). Each question goes to the feeds that can answer it, in the
 * order apps/order.ts gives, and the first answer wins. An app may import this file, so it
 * reaches the registry only when asked (loading an app never loads the registry).
 */

/** The feeds that have this part of the role, first asked first. */
async function feedsWith<Part extends keyof Tokens>(
  part: Part,
): Promise<readonly (Tokens & Required<Pick<Tokens, Part>>)[]> {
  const { filling } = await import("../apps/registry.ts");
  return filling("tokens").flatMap(({ part: feed }) =>
    feed[part] ? [feed as Tokens & Required<Pick<Tokens, Part>>] : [],
  );
}

/**
 * The first answer that `has` something, asking each in turn. When none has, `nothing`,
 * unless one couldn't be read: then nobody knows, and its failure is thrown.
 */
async function firstAnswer<Answer>(
  asks: readonly (() => Promise<Answer>)[],
  has: (answer: Answer) => boolean,
  nothing: Answer,
): Promise<Answer> {
  let failed: { readonly reason: unknown } | undefined;
  for (const ask of asks) {
    try {
      const answer = await ask();
      if (has(answer)) return answer;
    } catch (reason) {
      failed ??= { reason };
    }
  }
  if (failed) throw failed.reason;
  return nothing;
}

/** As many ids as a feed is asked for in one call (see Tokens.prices). */
const IDS_PER_CALL = 100;

/**
 * Each of these price ids' price, now or as it was near `at`, each as its own promise, so one
 * failing lookup costs only its own. The first feed is asked for them together, 100 to a call;
 * one it has no price for is asked of each later feed by itself. A promise resolves undefined
 * when no feed prices the token, and rejects when none did and one of them couldn't be read.
 */
export function feedPrices(
  ids: readonly string[],
  at?: Date,
): Map<string, Promise<TokenPrice | undefined>> {
  const feeds = feedsWith("prices");
  const asked = new Map<string, Promise<TokenPrice | undefined>>();
  for (let start = 0; start < ids.length; start += IDS_PER_CALL) {
    const batch = ids.slice(start, start + IDS_PER_CALL);
    const together = feeds.then(([first]) => first?.prices(batch, at));
    for (const id of batch)
      asked.set(
        id,
        feeds.then(([, ...later]) =>
          firstAnswer(
            [
              async () => (await together)?.get(id),
              ...later.map((feed) => async () => (await feed.prices([id], at)).get(id)),
            ],
            (price) => price !== undefined,
            undefined,
          ),
        ),
      );
  }
  return asked;
}

/**
 * SOL's price in dollars now, as the portfolio reads it, so pricing Solana's network fees takes no
 * key (a Solana route's price feed may need one, which a default install doesn't have).
 */
export async function solUsd(): Promise<number> {
  const id = NETWORKS.solana.coin.priceId;
  const price = await feedPrices([id])
    .get(id)!
    .then(
      (coin) => coin?.price,
      () => undefined,
    );
  if (!price) throw new Error("SOL's price can't be read just now, so try again in a moment.");
  return price;
}

/** A token's price from `from` (milliseconds) to now, a point each step, oldest first; empty when no feed keeps any. */
export async function feedHistory(
  id: string,
  step: Parameters<NonNullable<Tokens["history"]>>[1],
  from: number,
): Promise<PricePoint[]> {
  const feeds = await feedsWith("history");
  return firstAnswer(
    feeds.map((feed) => () => feed.history(id, step, from)),
    (points) => points.length > 0,
    [],
  );
}

/** A token's price now and its percent change over the last day; neither when no feed has them. */
export async function feedDay(
  id: string,
): Promise<{ readonly price?: number; readonly today?: number }> {
  const feeds = await feedsWith("day");
  return firstAnswer(
    feeds.map((feed) => () => feed.day(id)),
    (day) => day.price !== undefined || day.today !== undefined,
    {},
  );
}

/** What a token on an EVM chain is, as the first feed that lists it says (see Tokens.listing); null when none does. */
export async function feedListing(chain: string, token: string): Promise<TokenListing | null> {
  const feeds = await feedsWith("listing");
  return firstAnswer(
    feeds.map((feed) => () => feed.listing(chain, token)),
    (listing) => listing !== null,
    null,
  );
}

/**
 * Whether a feed's picture is one the web can draw: an https picture of at most 500 characters
 * (as the wire takes one) on a host the web's image server fetches from (servableImage). A
 * feed's picture on any other host would draw as initials, so the next feed is asked instead.
 */
export const shownLogo = (url: string) =>
  url.startsWith("https://") && url.length <= 500 && servableImage(url);

/**
 * A token's picture from the first feed that has one the web can show (see shownLogo).
 * Decoration: a feed that can't be read has none.
 */
export async function feedLogo(chain: string, token: string): Promise<string | null> {
  const feeds = await feedsWith("logo");
  return firstAnswer(
    feeds.map((feed) => () => feed.logo(chain, token)),
    (url) => url !== null && shownLogo(url),
    null,
  ).catch(() => null);
}

/**
 * The tokens a feed lists on a chain, by lowercased address, from the first feed that
 * lists any there; empty when none does. Throws while a feed that might couldn't be read.
 */
export async function feedListed(chain: string): Promise<ReadonlyMap<string, ListedToken>> {
  const feeds = await feedsWith("listed");
  return firstAnswer<ReadonlyMap<string, ListedToken>>(
    feeds.map((feed) => () => feed.listed(chain)),
    (list) => list.size > 0,
    new Map(),
  );
}

/**
 * The tokenized stocks the first feed that catalogs any lists; none when no feed does. Throws
 * while a feed that might couldn't be read (see Tokens.stocks).
 */
export async function feedStocks(): Promise<readonly XStock[]> {
  const feeds = await feedsWith("stocks");
  return firstAnswer<readonly XStock[]>(
    feeds.map((feed) => () => feed.stocks()),
    (stocks) => stocks.length > 0,
    [],
  );
}

/** What a feed says of a stock's market while it isn't open (see Tokens.marketNote); empty when none says. */
export async function feedMarketNote(stock: XStock): Promise<string> {
  const feeds = await feedsWith("marketNote");
  return firstAnswer(
    feeds.map((feed) => () => feed.marketNote(stock)),
    (note) => note !== "",
    "",
  ).catch(() => "");
}
