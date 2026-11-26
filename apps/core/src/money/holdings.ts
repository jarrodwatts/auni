import { setTimeout as sleep } from "node:timers/promises";

import {
  appListing,
  NETWORKS,
  type EvmChainKey,
  type holdingWireSchema,
  type NetworkKey,
} from "@auni/shared";
import type { z } from "zod";

import type { MarketFace } from "../apps/contract.ts";
import { accountOf, accountOwning, isSavings } from "../apps/registry.ts";
import { coinOf, isWrappedCoin } from "./coins.ts";
import { chainLabel } from "./chains.ts";
import { dayMoves } from "./day-moves.ts";
import { cleanName } from "./buckets.ts";
import { evmTokenKey, fillIdentity, solanaMintKey, type FillKey } from "./fill-key.ts";
import { heldLabel } from "./format.ts";
import type { Holding } from "./portfolio.ts";
import { listings } from "./recognised.ts";
import { cached } from "./swaps/shared.ts";
import { stockArt, stockIndex, stockName, type StockIndex } from "./swaps/stock-index.ts";
import { usdToCents } from "./usd.ts";
import { solanaTokens } from "./swaps/solana-swap.ts";
import { feedLogo, shownLogo } from "./token-feeds.ts";
import { paysOwnGas } from "./wallets.ts";

/** A holding as a person reads it: a real name, a quiet detail line, a logo, its value. */
type HoldingView = z.input<typeof holdingWireSchema>;

/** The artwork Auni ships for cash. */
export const LOGOS = {
  usdc: "/brand/tokens/usdc.svg",
} as const;

/** Logos are decoration: past this the view goes without one, and the lookup still fills the cache. */
const LOGO_WAIT_MS = 1_500;

/**
 * A token's artwork from the first listing that has it, keyed `chain:address`: on Solana the
 * route that trades it, then the token feeds. Misses are cached too.
 */
const tokenLogo = cached(10 * 60_000, async (key): Promise<string | null> => {
  // The chain may itself hold a colon (eip155:1), so the address is what follows the last.
  const chain = key.slice(0, key.lastIndexOf(":"));
  const address = key.slice(key.lastIndexOf(":") + 1);
  if (chain === "solana") {
    const listed = await solanaTokens([address]).catch(() => []);
    const url = listed.find((token) => token.mint === address)?.logoUrl;
    if (url && shownLogo(url)) return url;
  }
  return feedLogo(chain, address);
});

/** A token Auni knows: its name, what a quantity of it counts, and its mark. */
interface KnownToken {
  readonly name: string;
  readonly unit: string;
  readonly logoUrl: string;
}

/** A chain's own coin, or its wrapped form, as Auni knows it; null for any other token. */
function knownCoin(key: FillKey): KnownToken | null {
  const coin = coinOf(key);
  if (coin && isWrappedCoin(key))
    return { name: `Wrapped ${coin.name}`, unit: `W${coin.symbol}`, logoUrl: coin.logoUrl };
  return coin ? { name: coin.name, unit: coin.symbol, logoUrl: coin.logoUrl } : null;
}

/**
 * What Auni knows a token as: a chain's own coin, or a tokenized stock. Known
 * by chain and address alone, never by symbol, which any token can copy: a
 * Solana token named "TSLAx" is Tesla only at Tesla's mint. Null for any other.
 */
function knownToken(key: FillKey, stocks: StockIndex): KnownToken | null {
  const stock = stocks.byAddress.get(key.instrument.toLowerCase());
  return (
    knownCoin(key) ??
    (stock ? { name: stockName(stock), unit: "shares", logoUrl: stockArt(stock) } : null)
  );
}

/**
 * A token's picture by chain and address, the same wherever it shows: an
 * account's own token (a vault's shares) wears its app's logo, and no feed is
 * asked about it, as the portfolio reads it (see view); any other, the mark
 * Auni knows it by, else its listing's artwork. Null when nobody has one.
 */
export async function tokenArt(chain: string, address: string): Promise<string | null> {
  const key =
    chain === "solana" ? solanaMintKey(address) : evmTokenKey(chain as EvmChainKey, address);
  const owner = accountOwning(key);
  if (owner) return appListing(owner.about.id)?.logo ?? null;
  // A chain's own coin needs no stock catalog, whose cold read can take seconds, and every
  // card would wait out again while the catalog can't be read: a failed read isn't cached.
  const coin = coinOf(key);
  if (coin) return coin.logoUrl;
  return knownToken(key, await stockIndex())?.logoUrl ?? tokenLogo(`${chain}:${address}`);
}

function walletLogo(holding: Holding): Promise<string | null> {
  return Promise.race([
    tokenLogo(`${holding.chain}:${holding.instrument}`),
    sleep(LOGO_WAIT_MS, null),
  ]);
}

/** What the portfolio calls what a move trades, as its holding would be named. */
export interface Namer {
  /** A token by its address, as tokenCalled names it; null for one that goes by its symbol. */
  token(key: FillKey): Promise<string | null>;
  /** A perp market as the app `venue` (its id) shows it. */
  perp(venue: string, market: string): Promise<MarketFace>;
}

/** Names read from the stock catalog once for all of them. */
export async function namer(): Promise<Namer> {
  const index = await stockIndex();
  return { token: (key) => tokenCalled(key, index), perp: perpFace };
}

/** The longest name a list gives a token that Auni shows: "Wormhole Bridged WETH (Monad)" fits. */
const LISTED_NAME_MAX = 40;

/**
 * What a token is called, the same wherever it shows (its card, Activity, the portfolio, and the
 * holdings the agent reads): a chain's coin or a tokenized stock as Auni knows it, else what the
 * token list that recognises it calls it, as a person would say it (see listedName: "Tether
 * Gold" for XAUt0). Null for any other, which goes by its symbol: a token's own name is its
 * maker's word, and names nothing.
 */
export async function tokenCalled(key: FillKey, stocks?: StockIndex): Promise<string | null> {
  // A chain's own coin needs no stock catalog, whose cold read can take seconds.
  const known = knownCoin(key) ?? knownToken(key, stocks ?? (await stockIndex()));
  if (known) return known.name;
  const listed = (await listings(key.chain, [key.instrument], "unlisted")).get(fillIdentity(key));
  return listed?.name ? cleanName(listedName(listed.name), LISTED_NAME_MAX) : null;
}

/**
 * A list's name for a token as a person would say it: without the plural a list names some
 * entries in ("Tether Gold Tokens" for XAUt0, which is Tether Gold), which reads as a heap of
 * things bought ("Bought Tether Gold Tokens"). A singular "Token" stays: it is
 * often the name itself ("LEO Token"), or says what the token is of ("Gold Token" is not gold).
 * So does a bridged copy's provenance ("Axelar Bridged USDC"): it is not the coin it copies.
 */
function listedName(name: string): string {
  return name.replace(/\s+Tokens$/u, "");
}

/** A market as the account of the app `venue` (its id) shows it (see Account.market). */
export function perpFace(venue: string, market: string): Promise<MarketFace> {
  const named = accountOf(venue)?.account.market?.(market);
  return named ?? Promise.reject(new Error(`${venue} names no markets.`));
}

type HoldingFace = Omit<HoldingView, "todayChangeUsd">;

/**
 * Whether a holding is the coin the owner's wallet pays a chain's network fees in, on a chain
 * where nobody pays them for it: what lets every move there go, not something held for its
 * price. So it reads as that, and nothing Auni writes unasked offers to sell it (facts.ts).
 */
export async function paysFees(
  holding: Pick<Holding, "chain" | "instrument" | "venue">,
): Promise<boolean> {
  if (holding.instrument !== "native" || holding.venue !== "wallet") return false;
  if (!Object.hasOwn(NETWORKS, holding.chain)) return false;
  const { viem } = NETWORKS[holding.chain as NetworkKey];
  return paysOwnGas(viem ? viem.id : "solana");
}

/** A holding's id on the wire: by where it is and what it is. */
export function holdingId(holding: Pick<Holding, "chain" | "instrument">): string {
  return `${holding.chain}:${holding.instrument}`;
}

async function view(holding: Holding, stocks: StockIndex): Promise<HoldingFace> {
  const base = {
    id: holdingId(holding),
    usdValue: holding.usdValue ?? "0.00",
  };
  // Cash orders hold reads the same at any account, wearing its app's logo.
  if (holding.heldForOrders) {
    const app = appListing(holding.venue);
    return {
      ...base,
      name: "Held for orders",
      detail: `Waiting on ${app?.name ?? holding.venue}`,
      logoUrl: app?.logo ?? LOGOS.usdc,
    };
  }
  // Plain cash reads the same wherever it waits; savings read as their account says.
  if (holding.cash && !isSavings(holding.venue))
    return { ...base, name: "Cash", detail: "US dollars", logoUrl: LOGOS.usdc };
  // What an account owns reads as the account says, wearing its app's logo unless it has a
  // picture of its own.
  const owner = accountOwning(holding);
  if (owner) {
    const face = await owner.account.face(holding);
    const fallback = appListing(owner.about.id)?.logo ?? (holding.cash ? LOGOS.usdc : null);
    return { ...base, name: face.name, detail: face.detail, logoUrl: face.logoUrl ?? fallback };
  }
  const known = knownToken(holding, stocks);
  if (known) {
    const forFees = (await paysFees(holding)) ? " for network fees" : "";
    return {
      ...base,
      name: known.name,
      detail: `${heldLabel(holding.quantity)} ${known.unit}${forFees}`,
      logoUrl: known.logoUrl,
    };
  }
  const [called, logoUrl] = await Promise.all([tokenCalled(holding, stocks), walletLogo(holding)]);
  return {
    ...base,
    name: called ?? holding.symbol,
    detail: `${heldLabel(holding.quantity)} ${holding.symbol}`,
    logoUrl,
  };
}

/** Names and logos alone, in the holdings' order, without day moves or colours. */
export async function holdingFaces(holdings: readonly Holding[]): Promise<HoldingFace[]> {
  // Nothing to name needs no stock catalog, whose cold read can take seconds.
  if (holdings.length === 0) return [];
  const stocks = await stockIndex();
  const faces = await Promise.all(holdings.map((holding) => view(holding, stocks)));
  // One coin on two chains reads the same twice ("ETH", "ETH"), so each says where it is.
  const chain = (index: number) => holdings[index]!.chain;
  return faces.map((face, index) =>
    faces.some((other, at) => other.name === face.name && chain(at) !== chain(index))
      ? { ...face, name: `${face.name} on ${chainLabel(chain(index))}` }
      : face,
  );
}

/** Largest first, so the first few are the logos a card shows; each with its move since `today` began (see dayMoves). */
export async function holdingViews(all: readonly Holding[], today: number): Promise<HoldingView[]> {
  // A crumb worth under a cent, like the dust a sale leaves, isn't something a person holds. One
  // with no price now still is: only what's theirs or recognised gets here (see buckets.ts), as a
  // buy whose token lost its price, or any holding while prices can't be read.
  const holdings = all.filter(
    (holding) => holding.cash || holding.usdValue === null || usdToCents(holding.usdValue) > 0n,
  );
  // Nothing held needs no stock catalog, whose cold read takes seconds.
  if (holdings.length === 0) return [];
  const [faces, moves] = await Promise.all([holdingFaces(holdings), dayMoves(holdings, today)]);
  const views = holdings.map((_, index): HoldingView => ({
    ...faces[index]!,
    todayChangeUsd: moves[index] ?? null,
  }));
  return views.toSorted((left, right) => {
    const difference = usdToCents(right.usdValue) - usdToCents(left.usdValue);
    return difference === 0n ? 0 : difference > 0n ? 1 : -1;
  });
}
