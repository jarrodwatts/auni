import { RAW_TRANSACTION_TOOLS } from "@auni/shared";
import { z } from "zod";

import type { AppLogo } from "./app-logo.ts";
import type { AppTerms } from "./card-face.ts";
import type { ActionRow } from "../db/schema.ts";
import { plainWords } from "../agent/plain-words.ts";
import { approvedTokens } from "./approved.ts";
import { chainIdOf, chainKey, evmChainById, evmClient } from "./chains.ts";
import { coinOf, isWrappedCoin } from "./coins.ts";
import { staysYours, type Amount, type Effect } from "./effect.ts";
import { tokenKey, type FillChain, type FillKey } from "./fill-key.ts";
import { formatAmount, priceLabel, shortAddress, usdLabel } from "./format.ts";
import { tradedToken, type Fill, type Sale, type Subject } from "./recipe.ts";
import { formatUnits } from "./usd.ts";
import {
  amounts,
  grantLabel,
  worth,
  type Moved,
  type Simulated,
  type TokenLeg,
  type TokenName,
} from "./wallet-effect.ts";

// What a transaction the agent built shows and records, on any chain: the card's
// words, its app's look, and the fills read from what it moved.

/**
 * A recorded raw transaction's chain, as fills name it, and the holdings its
 * card showed it sending and getting there; `moved` is null for one drawn
 * without a simulation, which could move anything on its chain.
 */
export function shownHoldings(row: Pick<ActionRow, "tool" | "input" | "details">): {
  readonly chain: FillChain;
  readonly moved: { readonly sends: FillKey[]; readonly gets: FillKey[] } | null;
} {
  const chain =
    row.tool === "send_solana_transaction"
      ? "solana"
      : chainKey(chainIdOf(String((row.input as { chain?: unknown }).chain)));
  const shown = approvedTokens(row);
  const keys = (tokens: readonly string[]) => tokens.map((token) => tokenKey(chain, token));
  return { chain, moved: shown && { sends: keys(shown.sends), gets: keys(shown.gets) } };
}

/** The fields every raw transaction tool takes besides the transaction itself. */
export const rawTransactionInput = {
  summary: plainWords(160).describe(
    'The card\'s title, short and plain, starting with what it does: "Stake ETH on Lido".',
  ),
  app: z
    .object({
      name: plainWords(40).describe('As people know it: "Uniswap", "Morpho", "Curve".'),
      site: z
        .string()
        .max(100)
        .refine((site) => siteHost(site) !== null, 'A website\'s host: "uniswap.org".')
        .describe('Its website, where its logo comes from: "uniswap.org".'),
      verb: plainWords(24).describe(
        '"swap", "deposit" or "move" (a bridge) each draw their own card; any other word ("stake", "claim") draws the plain one.',
      ),
      to_chain: plainWords(40).optional().describe("For a move, the chain it lands on."),
      note: plainWords(160)
        .optional()
        .describe(
          "One plain sentence the owner should know that running the transaction can't show: what it earns, how long getting out takes. The card shows it apart, under a heading that says Auni did not check it, and leaves it off a card that also checks it's the owner.",
        ),
    })
    .optional()
    .describe(
      "The app the transaction uses, so its card wears that app's name and logo and says there is no app of Auni's for it yet. Only the look; nothing checks it. A transaction whose every call goes to the contracts of one of Auni's apps, or approves one of them, wears that app's name and words instead, and shows no note.",
    ),
};

/**
 * The app a transaction is for, as its card names it: the agent's own hint, or the words of the
 * app whose contracts the whole batch calls (money/readers.ts), which may also give the card's
 * title and one line of fine print no simulation can show.
 */
export type AppHint = Omit<NonNullable<z.infer<typeof rawTransactionInput.app>>, "site"> & {
  readonly title?: string;
  readonly finePrint?: string;
  /** Set when an app whose own contracts the batch calls gave these words, and not the agent. */
  readonly vouched?: true;
  /**
   * Set when the agent's hint names one of Auni's apps, which vouches for none of it: that app's
   * name, so the card says the app doesn't know this contract (see appNamed).
   */
  readonly unknownTo?: string;
};

/**
 * The agent's hint as the card of `effect` may carry it. Its note is the agent's own word, which
 * nothing checks, so it rides only on a card where the money stays the owner's with no new power
 * over it (see staysYours), which always goes on a tap. Any other card may take the owner's proof, and
 * one that does shows only what was checked.
 */
export function hintFor(app: AppHint, effect: Effect): AppHint {
  return staysYours(effect) ? app : { ...app, note: undefined };
}

/**
 * The dollars a raw transaction's card says it moves: what its simulation saw leave the wallet,
 * at the listed prices, and never a figure the agent gave. Zero, so the card shows no amount,
 * when it couldn't be simulated or any of what leaves has no price Auni can check.
 */
export function leavesUsd(seen: Moved | null, names: ReadonlyMap<string, TokenName>): string {
  const priced = seen?.out.every(({ token }) => names.get(token)?.usd) ?? false;
  return (seen && priced ? worth(seen.out, names) : 0).toFixed(2);
}

/**
 * A raw transaction's effect, from what its simulation saw it do to the
 * wallet: the agent wrote every byte, so nothing else vouches for it. What comes
 * back counts only in the wallet; anything it sends with nothing back leaves
 * the owner, for wherever the simulation saw it go. Every permission it leaves
 * reaches the main wallet. What comes back short of what goes, both at market
 * prices, is a cost. No simulation is blind, and so takes the owner's proof, as is a
 * trade a tap can't vouch for (see unvouchedTrade).
 */
export function rawEffect(seen: Simulated | null, names: ReadonlyMap<string, TokenName>): Effect {
  if (!seen) return { gives: [], gets: [], grants: [], blind: "can't be checked in a simulation" };
  const amount = (leg: TokenLeg): Amount => {
    const usd = worth([leg], names);
    return { text: amounts([leg], names), ...(usd > 0 ? { usd } : {}) };
  };
  const priced = [...seen.out, ...seen.in].every(({ token }) => names.get(token)?.usd);
  const lost = priced && seen.in.length ? worth(seen.out, names) - worth(seen.in, names) : 0;
  const blind = unvouchedTrade(seen, names);
  return {
    gives: seen.out.map(amount),
    gets: seen.in.map(amount),
    grants: seen.grants.map((grant) => ({ lets: grantLabel(grant, names), reach: "wallet" })),
    ...(lost >= 0.01 ? { costs: [{ label: "lost at market prices", usd: lost }] } : {}),
    ...(seen.sentTo ? { to: seen.sentTo } : {}),
    ...(blind ? { blind } : {}),
  };
}

/**
 * Why what a raw transaction trades can't go on a tap; null when it sends
 * nothing, or nothing back (which leaves the owner, judged by where it goes).
 * The agent's bytes name no least they get, unlike a route quoted against a
 * market, and anyone can make a token and name it anything: what comes back
 * vouches for what goes only when both sides are listed and priced, and it's
 * worth at least half. Else a contract could take the wallet's dollars for a
 * token it mints, or for dust. Tokens are named, never counted, so the reason
 * is the same at execute as on the card.
 */
function unvouchedTrade(seen: Moved, names: ReadonlyMap<string, TokenName>): string | null {
  if (!seen.out.length || !seen.in.length) return null;
  const unpriced = new Set(
    [...seen.out, ...seen.in].flatMap(({ token }) => (names.get(token)?.usd ? [] : [token])),
  );
  if (unpriced.size)
    return `moves ${[...unpriced].map(shortAddress).join(" and ")}, which Auni can't price`;
  if (worth(seen.in, names) < worth(seen.out, names) / 2)
    return `brings back ${seen.in.map(({ token }) => names.get(token)!.symbol).join(" and ")}, worth under half of what it sends`;
  return null;
}

const DOLLARS = /^USD[CT]$/u;

/**
 * Which side of a one-for-one trade the owner is on: trading into dollars sells
 * what goes, and anything else buys what comes back. Null for any other shape.
 */
export function tradeSide(effect: Moved, names: ReadonlyMap<string, TokenName>) {
  const [got] = effect.in;
  if (effect.out.length !== 1 || effect.in.length !== 1 || !got) return null;
  return DOLLARS.test(names.get(got.token)?.symbol ?? "") ? "sell" : "buy";
}

/**
 * What a recorded raw transaction did when it only wrapped its chain's own
 * coin into its token (MON into WMON) or unwrapped it, by what its card
 * showed it sending and getting, with the coin's symbol; null for anything
 * else. Either is no buy or sale: the coin stays the coin.
 */
export function wrapOf(
  row: Pick<ActionRow, "tool" | "input" | "details">,
): { readonly wraps: boolean; readonly symbol: string } | null {
  if (!(RAW_TRANSACTION_TOOLS as readonly string[]).includes(row.tool)) return null;
  const { moved } = shownHoldings(row);
  const [sent, ...moreSent] = moved?.sends ?? [];
  const [got, ...moreGot] = moved?.gets ?? [];
  if (!sent || !got || moreSent.length > 0 || moreGot.length > 0) return null;
  const coin = coinOf(sent);
  if (coin === null || coin !== coinOf(got)) return null;
  if (sent.instrument === "native" && isWrappedCoin(got)) return { wraps: true, ...coin };
  if (isWrappedCoin(sent) && got.instrument === "native") return { wraps: false, ...coin };
  return null;
}

/**
 * What a raw transaction is about, from what its describe pinned: the token it
 * trades, else the app the agent named, else the chain it runs on, wearing its coin.
 */
export function rawSubject(details: Record<string, string>, chain: FillChain): Subject {
  return (
    tradedToken(details, 0) ??
    (details.app
      ? { kind: "app", name: details.app, logo: details.appLogo ?? null }
      : {
          kind: "app",
          name: details.network ?? chain,
          logo: coinOf({ chain, instrument: "native" })?.logoUrl ?? null,
        })
  );
}

/**
 * What a raw transaction's details pin for rawSubject: the token it trades,
 * by address and symbol, else the app the agent named and its logo.
 */
export function subjectDetails(
  chain: FillChain,
  traded: TokenLeg | undefined,
  names: ReadonlyMap<string, TokenName>,
  app: AppHint | undefined,
  logo: AppLogo | null,
): Record<string, string> {
  if (traded) {
    const symbol = names.get(traded.token)?.symbol;
    return { chain, mint: traded.token, ...(symbol ? { token: symbol } : {}) };
  }
  return app ? { app: app.name, ...(logo ? { appLogo: logo.src } : {}) } : {};
}

/** A site as its bare host, "app.uniswap.org", or null when it isn't one. */
export function siteHost(site: string): string | null {
  try {
    const { hostname } = new URL(/^https?:\/\//iu.test(site) ? site : `https://${site}`);
    const host = hostname.replace(/^www\./u, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** A chain as people name it, whether the agent gave its key, its id or its name. */
function chainLabel(chain: string): string {
  try {
    const id = chainIdOf(chain);
    return evmChainById(id)?.name ?? evmClient(id).chain?.name ?? `Chain ${id}`;
  } catch {
    return chain.charAt(0).toUpperCase() + chain.slice(1);
  }
}

/**
 * The card for the app the agent named. Its word picks the layout only when the
 * simulation fits it: a swap sends one token and gets another, a deposit
 * sends one and gets one back, a move sends one toward another chain. Every
 * figure is the simulation's, at the chain's listed prices.
 */
export function appTerms(
  app: AppHint,
  site: string | null,
  logo: AppLogo | null,
  effect: Simulated,
  names: ReadonlyMap<string, TokenName>,
  chain: string,
  networkFee: string | null,
  via: string,
): AppTerms {
  const tokens = ({ token, amount }: TokenLeg) => {
    const name = names.get(token);
    return name ? Number(formatUnits(amount, name.decimals)) : null;
  };
  const leg = (each: TokenLeg) => {
    const name = names.get(each.token);
    const count = tokens(each);
    return {
      amount: count === null ? String(each.amount) : formatAmount(count),
      symbol: name?.symbol ?? shortAddress(each.token),
      name: name?.name ?? null,
      usd: count !== null && name?.usd ? usdLabel(count * name.usd) : null,
    };
  };
  const [sent] = effect.out;
  const [got] = effect.in;
  const one = effect.out.length === 1 && effect.in.length === 1 && sent && got;
  const toChain = app.to_chain ? chainLabel(app.to_chain) : null;
  const layout = (() => {
    switch (app.verb.toLowerCase()) {
      case "swap":
        return tradeSide(effect, names);
      case "deposit":
        return one ? "deposit" : null;
      case "move":
        return effect.out.length === 1 && toChain && toChain !== chain ? "move" : null;
      default:
        return null;
    }
  })();
  const priced = (legs: readonly TokenLeg[]) => legs.every(({ token }) => names.get(token)?.usd);
  const trade = one && (layout === "buy" || layout === "sell") && priced([sent, got]);
  const [paid, bought] = layout === "sell" ? [got, sent] : [sent, got];
  const count = trade ? tokens(bought!) : null;
  const change = trade ? worth([got], names) / worth([sent], names) - 1 : null;
  return {
    app: app.name,
    site,
    logo,
    layout,
    chain,
    toChain,
    sends: effect.out.map(leg),
    gets: effect.in.map(leg),
    price: count ? priceLabel(worth([paid!], names) / count) : null,
    vsMarket:
      change === null
        ? null
        : Math.abs(change) < 0.0005
          ? "About even"
          : `${(Math.abs(change) * 100).toFixed(1)}% ${change < 0 ? "worse" : "better"}`,
    networkFee,
    leaves: effect.grants.map((grant) => grantLabel(grant, names)).join(" and ") || null,
    to: effect.sentTo ?? [],
    via,
    title: app.title ?? null,
    finePrint: app.finePrint ?? null,
    vouched: app.vouched === true,
    note: app.note ?? null,
    unknownTo: app.unknownTo ?? null,
  };
}

/**
 * What a raw transaction bought and sold: each asset out is a sell and each
 * in a buy. Only priced tokens are holdings, and the chain's USDC is cash. A
 * one-for-one trade is worth the cash side, else what was sold; in a bigger
 * transaction each asset is worth its price.
 */
/**
 * The one holding a raw transaction lets go of, for its card to name as what
 * it sells, so its sale is written to whoever held it, as any sale's is: when
 * its simulation shows exactly one token leaving that isn't cash. None for a
 * batch sending more, which is written where it was made.
 */
export function rawSale(
  moved: Moved | null,
  names: ReadonlyMap<string, TokenName>,
  isCash: (token: string) => boolean,
  keyOf: (token: string) => FillKey,
): Sale | undefined {
  const leaving = moved?.out.filter(({ token }) => !isCash(token)) ?? [];
  const [leg] = leaving;
  const name = leg && names.get(leg.token);
  if (leaving.length !== 1 || !leg || !name) return undefined;
  return { ...keyOf(leg.token), quantity: formatUnits(leg.amount, name.decimals) };
}

export function fillsFor(
  moved: Moved,
  names: ReadonlyMap<string, TokenName>,
  isCash: (token: string) => boolean,
  keyOf: (token: string) => FillKey,
): Fill[] {
  const { out, in: into } = moved;
  const [sold] = out;
  const paid =
    out.length === 1 && into.length === 1
      ? (into.find(({ token }) => isCash(token)) ?? sold)
      : undefined;
  const tradeUsd = paid ? worth([paid], names) : 0;
  const fill =
    (side: Fill["side"]) =>
    (leg: TokenLeg): Fill[] => {
      const name = names.get(leg.token);
      if (isCash(leg.token) || !name?.usd) return [];
      const quantity = formatUnits(leg.amount, name.decimals);
      const usdValue = (tradeUsd || worth([leg], names)).toFixed(2);
      return [{ ...keyOf(leg.token), side, quantity, usdValue }];
    };
  return [...out.flatMap(fill("sell")), ...into.flatMap(fill("buy"))];
}
