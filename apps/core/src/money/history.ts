import { NETWORKS, type NetworkKey } from "@auni/shared";
import { accountOf, accountOwning, isMargined, savingsTokens } from "../apps/registry.ts";
import { isPlainCash } from "./coins.ts";
import type { FillChain } from "./fill-key.ts";
import type { ReadingHolding } from "./portfolio.ts";
import { cached, onForget } from "./swaps/shared.ts";
import { feedHistory, feedPrices } from "./token-feeds.ts";

/**
 * Prices, live and over time. What the owner holds is read at each venue;
 * what a thing is worth is public, so its price is read once, cached, and
 * shared by every reading that needs it. A holding is priced through
 * one source live and in history alike (see priceKey), so a move between two
 * of its prices is never two sources disagreeing.
 */

/** One price at one moment, in milliseconds. */
export interface PricePoint {
  readonly at: number;
  readonly price: number;
}

/** A token's price. Never its name: a price feed copies whatever its maker chose (see tokenName). */
export interface TokenPrice {
  readonly price: number;
}

/** How finely a history is read: "Today" draws a point every 15 minutes, a week every hour. */
export type Step = "15m" | "1h";

/** What a holding needs to be priced: its feed, or the perp or outcome its chain and instrument name. */
type Priceable = Pick<ReadingHolding, "chain" | "instrument" | "priceId" | "cash">;

/**
 * Where a holding's price comes from, as one key for live prices and history
 * alike. Anything an account owns and prices is priced by that account, under
 * its app's id and the holding's instrument ("<app id>:xyz:NVDA"): a
 * perp, an outcome share, or a wallet token it issues, which no public feed
 * need list. Any other token is priced by the public feeds, under its price id
 * ("token:coingecko:solana"; see Tokens in apps/contract.ts). Null for cash, which holds its value, and
 * anything with no feed. Keys are only ever held in memory, so their shape is
 * free to change.
 */
export function priceKey(holding: Priceable): string | null {
  if (holding.cash) return null;
  const owner = accountOwning({
    chain: holding.chain as FillChain,
    instrument: holding.instrument,
  });
  if (owner?.account.prices) return `${owner.about.id}:${holding.instrument}`;
  return holding.priceId ? `token:${holding.priceId}` : null;
}

/** The account whose prices a key that isn't a token's names, by its app's id (see priceKey). */
function venuePrices(kind: string) {
  const prices = accountOf(kind)?.account.prices;
  if (!prices) throw new Error(`No account prices ${kind}.`);
  return prices;
}

function source(key: string): { readonly kind: string; readonly id: string } {
  const split = key.indexOf(":");
  return { kind: key.slice(0, split), id: key.slice(split + 1) };
}

/** How a perp's value moves: by its size times the change in its mark, a short gaining as it falls. */
export interface PerpSize {
  readonly size: number;
  readonly short: boolean;
}

/** A perp's size and side, `share` of it; null for anything worth units times a price. */
export function perpSize(
  holding: Pick<ReadingHolding, "chain" | "instrument" | "quantity" | "short">,
  share = 1,
): PerpSize | null {
  if (!isMargined(holding)) return null;
  return { size: Number(holding.quantity) * share, short: holding.short ?? false };
}

/**
 * A holding's value at another price. A token or an outcome share is worth
 * its price times however many the price counts, so it moves in proportion to
 * the price, whatever unit its balance is kept in: an xStock's balance carries
 * a multiplier its price doesn't. A perp moves by its size times the change,
 * and never below zero, where an isolated position is closed. Without both
 * prices it holds its value.
 */
export function movedUsd(
  usd: number,
  perp: PerpSize | null,
  from: number | null,
  to: number | null,
): number {
  if (from === null || to === null) return usd;
  if (!perp) return from > 0 ? (usd * to) / from : usd;
  return Math.max(0, usd + perp.size * (to - from) * (perp.short ? -1 : 1));
}

/** The price a path had at `at`: its last at or before then, its first before it starts; null when it has none. */
export function priceAt(path: readonly PricePoint[], at: number): number | null {
  let price = path[0]?.price ?? null;
  for (const point of path) {
    if (point.at > at) break;
    price = point.price;
  }
  return price;
}

const LIVE_TTL_MS = 60_000;

/** Each token's price now as the feeds say it, by price id, kept a minute. */
const feedLive = new Map<
  string,
  { readonly at: number; readonly price: Promise<TokenPrice | undefined> }
>();
onForget(() => feedLive.clear());

/**
 * Tokens' live prices by price id, each kept a minute; those not kept are asked of the feeds
 * (see feedPrices). A token with no price is left out. `complete` is false when a token has
 * no price and a feed asked of it couldn't be read, and the prices that were read come back
 * either way, so one failing lookup costs only its own.
 */
export async function tokenPrices(
  ids: readonly string[],
): Promise<{ prices: Map<string, TokenPrice>; complete: boolean }> {
  const wanted = [...new Set(ids)];
  const now = Date.now();
  for (const [id, entry] of feedLive) if (now - entry.at >= LIVE_TTL_MS) feedLive.delete(id);
  for (const [id, price] of feedPrices(wanted.filter((id) => !feedLive.has(id)))) {
    const entry = { at: now, price };
    feedLive.set(id, entry);
    // A failure is forgotten at once, so the next read asks again.
    entry.price.catch(() => {
      if (feedLive.get(id) === entry) feedLive.delete(id);
    });
  }
  const lookups = await Promise.allSettled(
    wanted.map(async (id) => [id, await feedLive.get(id)?.price] as const),
  );
  const prices = new Map<string, TokenPrice>();
  let complete = true;
  for (const lookup of lookups) {
    if (lookup.status === "rejected") {
      console.warn("token price unavailable:", lookup.reason);
      complete = false;
      continue;
    }
    const [id, price] = lookup.value;
    if (price) prices.set(id, price);
  }
  return { prices, complete };
}

/**
 * What each of these was worth at one moment, in dollars, by price key (see priceKey). A token
 * is priced by a feed's nearest price within a few hours, which for a moment just past is its
 * latest; what an account owns and prices, by that account's history at that moment. One with no
 * price then is priced now, as the portfolio prices it, so what it counts always has one; a
 * token with neither is left out. A lookup that fails throws.
 */
export async function pricesAt(keys: readonly string[], at: Date): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const wanted = [...new Set(keys)].map((key) => ({ key, ...source(key) }));
  const coins = wanted.filter(({ kind }) => kind === "token");
  const read = feedPrices(
    coins.map(({ id }) => id),
    at,
  );
  await Promise.all(
    coins.map(async ({ key, id }) => {
      const coin = await read.get(id);
      if (coin && coin.price > 0) prices.set(key, coin.price);
    }),
  );
  await Promise.all(
    wanted.map(async ({ key, kind, id }) => {
      if (kind === "token") return;
      const path = await venuePrices(kind).history(id, "1h", at.getTime());
      const then = priceAt(path, at.getTime());
      if (then !== null) prices.set(key, then);
    }),
  );
  const unpriced = wanted.flatMap(({ key }) => (prices.has(key) ? [] : [key]));
  if (unpriced.length === 0) return prices;
  const now = await pricesNow(unpriced);
  if (!now.complete) throw new Error("Live prices couldn't be read.");
  for (const [key, price] of now.prices) prices.set(key, price);
  return prices;
}

/**
 * What each of these is worth now, in dollars, by price key (see priceKey): a token at the
 * public feeds' price (see tokenPrices), what an account owns and prices at that account's own.
 * `complete` is false when a price couldn't be read, as opposed to a token that has none: an
 * account always has a price for what it owns, so one it didn't give couldn't be read.
 */
export async function pricesNow(
  keys: readonly string[],
): Promise<{ prices: Map<string, number>; complete: boolean }> {
  const wanted = [...new Set(keys)].map((key) => ({ key, ...source(key) }));
  const coins = wanted.filter(({ kind }) => kind === "token");
  const owned = wanted.flatMap(({ key, kind }) => (kind === "token" ? [] : [key]));
  const [feeds, prices] = await Promise.all([
    tokenPrices(coins.map(({ id }) => id)),
    livePrices(owned),
  ]);
  for (const { key, id } of coins) {
    const price = feeds.prices.get(id)?.price;
    if (price !== undefined) prices.set(key, price);
  }
  return { prices, complete: feeds.complete && owned.every((key) => prices.has(key)) };
}

/**
 * The price key (see priceKey) of a token in the wallet on one of Auni's networks, or of the
 * network's own coin ("native"); null for what is worth a dollar a unit: plain cash, and the
 * token savings are held as (aUSDC), as the portfolio counts both.
 */
export function walletPriceKey(chain: NetworkKey, instrument: string): string | null {
  const cash =
    isPlainCash(chain, instrument) ||
    savingsTokens(chain).some(({ token }) => token.toLowerCase() === instrument.toLowerCase());
  const priceId = instrument === "native" ? NETWORKS[chain].coin.priceId : `${chain}:${instrument}`;
  return priceKey({ chain, instrument, cash, priceId });
}

/**
 * Each of these keys' price now (see priceKey), each as its own promise, so
 * one slow source holds up only its own: tokens share one batch, and each
 * perp and outcome is read on its own. One that can't be read is undefined.
 */
function livePriceEach(keys: readonly string[]): Map<string, Promise<number | undefined>> {
  const unique = [...new Set(keys)];
  const tokens = unique.flatMap((key) => {
    const { kind, id } = source(key);
    return kind === "token" ? [id] : [];
  });
  const quoted = tokenPrices(tokens).then(({ prices }) => prices);
  return new Map(
    unique.map((key) => {
      const { kind, id } = source(key);
      const price = (
        kind === "token"
          ? quoted.then((prices) => prices.get(id)?.price)
          : Promise.resolve().then(() => venuePrices(kind).live(id))
      ).then(
        (price) => (price !== undefined && Number.isFinite(price) && price > 0 ? price : undefined),
        () => undefined,
      );
      return [key, price];
    }),
  );
}

/** Each of these keys' price now (see priceKey), once all are read; one that can't be read is left out. */
export async function livePrices(keys: readonly string[]): Promise<Map<string, number>> {
  const entries = await Promise.all(
    [...livePriceEach(keys)].map(async ([key, price]) => [key, await price] as const),
  );
  return new Map(entries.flatMap(([key, price]) => (price === undefined ? [] : [[key, price]])));
}

const DAY_MS = 24 * 60 * 60_000;
const STEP_MS: Readonly<Record<Step, number>> = { "15m": 15 * 60_000, "1h": 60 * 60_000 };
/**
 * How far back each history reads: past the start of "Today" and of the week,
 * to the reading just before either. The same window every time, so one
 * cached read serves every reading.
 */
const WINDOW_MS: Readonly<Record<Step, number>> = { "15m": 2 * DAY_MS, "1h": 8 * DAY_MS };

/** A key's history over its step's window, oldest first; empty when its source keeps none. */
async function readHistory(key: string, step: Step): Promise<PricePoint[]> {
  const { kind, id } = source(key);
  const start = Date.now() - WINDOW_MS[step];
  if (kind === "token") return feedHistory(id, step, start);
  return venuePrices(kind).history(id, step, start);
}

/**
 * Each history is read again once one of its steps has passed, when it has
 * a new point; until then everyone shares it. Every path ends in the live
 * price anyway (see pricePaths).
 */
const histories: Readonly<Record<Step, (key: string) => Promise<PricePoint[]>>> = {
  "15m": cached(STEP_MS["15m"], (key) => readHistory(key, "15m")),
  "1h": cached(STEP_MS["1h"], (key) => readHistory(key, "1h")),
};

/**
 * Each key's price path: its history at `step`, ending in its live price at
 * `now`, so a line drawn to `now` from it ends where the number on screen is.
 * A history read after `now` can end later, its still-open step stamped
 * then, so the live price takes over from `now` on. Never rejects: a source
 * that can't be read leaves a shorter path, or none, and a holding with no
 * path holds its value.
 */
export function pricePaths(
  keys: readonly string[],
  step: Step,
  now: number,
): Map<string, Promise<PricePoint[]>> {
  const live = livePriceEach(keys);
  return new Map(
    [...live].map(([key, price]) => [
      key,
      Promise.all([histories[step](key).catch(() => []), price]).then(([history, price]) =>
        price === undefined
          ? history
          : [...history.filter((point) => point.at < now), { at: now, price }],
      ),
    ]),
  );
}

/** Every path, once all are read. */
export async function readPaths(
  keys: readonly string[],
  step: Step,
  now: number,
): Promise<Map<string, PricePoint[]>> {
  return new Map(
    await Promise.all(
      [...pricePaths(keys, step, now)].map(async ([key, path]) => [key, await path] as const),
    ),
  );
}
