import { NETWORK_KEYS, NETWORKS, listed, type NetworkKey } from "@auni/shared";
import { sql } from "drizzle-orm";
import { formatEther, getAddress } from "viem";

import { actions, type ActionRow } from "../db/schema.ts";
import type { FillKey } from "./fill-key.ts";
import { formatAmount, usdLabel } from "./format.ts";
import type { PayInStatus } from "./pay-in.ts";
import type { ActionPreview } from "./recipe.ts";

// What a card pins and says of the coin it buys for a chain's fees, on every chain: an EVM
// chain's coin bought from a chain that can pay (fee-coin.ts plans that purchase and makes it),
// and SOL, bought as a move on Solana needs it (sol-top-up.ts). One purchase, pinned one way, so
// one set of rules holds it everywhere: it is made at most once for a card, counts in a
// specialist's pot and a plan's sums, and is said by every drawing of the card. It is the one
// place those words are made: the web's card and plan, a channel's copy, what the agent is told,
// and what a move says when the coin doesn't come all read them from here, so no card the owner
// can allow leaves out a send its Allow signs. It loads nothing that reads a chain or a wallet,
// so anything that draws or weighs a card can read it.

/** A purchase of a chain's coin for its fees, as a card shows it and execute is held to it. */
export interface FeeCoin {
  /** The chain whose coin is bought, where it arrives at the wallet's own address. */
  readonly chain: NetworkKey;
  /**
   * The chain that pays, and what with: its USDC by address or mint, or "native" for its own
   * coin. Another chain pays through the pay-in service, which then pays the wallet the coin,
   * its promise and nothing the chain enforces. The same chain pays by a swap there, which
   * rests on nobody.
   */
  readonly from: NetworkKey;
  readonly token: string;
  /** Exactly what is spent, in that token's base units. */
  readonly amount: bigint;
  /** What that is worth: cash the card spends, but no cost, as most of the coin stays. */
  readonly usd: number;
  /** The service that carries it, by name: the pay-in service, or the route the swap is on. */
  readonly by: string;
  /**
   * Set where what pays comes out of the money the move itself sends (a bridge out of Solana
   * buys its SOL with some of the USDC it carries): spending already inside the card's amount,
   * so nothing beside it for a pot or a plan's sums to count.
   */
  readonly within?: true;
  /**
   * Set where the coin is bought for the other moves on its card too (SOL, see buyingSolOnce):
   * the move runs ahead of the moves beside it in its stage, so they find it there.
   */
  readonly ahead?: true;
}

export const symbol = (chain: NetworkKey) =>
  chain === "solana" ? "SOL" : NETWORKS[chain].viem.nativeCurrency.symbol;
const isOurs = (chain: string): chain is NetworkKey =>
  (NETWORK_KEYS as readonly string[]).includes(chain);
/** Whether the purchase is a swap on the chain itself, not a deposit with the pay-in service. */
const swaps = (bought: FeeCoin) => bought.from === bought.chain;
/**
 * How a send that swaps for the coin on the chain itself is kept as its card's purchase
 * (KeptTx.buysFees): it has no order with anyone, as a deposit with the pay-in service has.
 */
export const SWAPPED = "swap";

/** What the purchase pays with, as a person reads it: "$0.50 of USDC", "30.8 MON". */
export function paysWith({ from, token, amount, usd }: FeeCoin): string {
  return token === "native"
    ? `${formatAmount(Number(formatEther(amount)))} ${symbol(from)}`
    : `${usdLabel(usd)} of USDC`;
}

const KEYS = {
  chain: "feeCoinOn",
  from: "feeCoinFrom",
  token: "feeCoinToken",
  amount: "feeCoinAmount",
  usd: "feeCoinUsd",
  by: "feeCoinBy",
  within: "feeCoinWithin",
  ahead: "feeCoinAhead",
} as const;

/** The purchase a card pinned (see feeCoinDetails), or null for a card that buys none. */
export function pinned(details: Record<string, string>): FeeCoin | null {
  const { chain, from, token, amount, usd, by, within, ahead } = Object.fromEntries(
    Object.entries(KEYS).map(([name, key]) => [name, details[key]]),
  );
  if (!chain || !from || !token || !amount || !usd || !by) return null;
  if (!isOurs(chain) || !isOurs(from)) return null;
  return {
    chain,
    from,
    // An EVM token by its checksummed address; a Solana mint, where case counts, as it is.
    token: token === "native" || from === "solana" ? token : getAddress(token),
    amount: BigInt(amount),
    usd: Number(usd),
    by,
    ...(within ? { within: true as const } : {}),
    ...(ahead ? { ahead: true as const } : {}),
  };
}

/** What a card keeps of its purchase, which execute is held to and every drawing reads. */
export function feeCoinDetails(bought: FeeCoin): Record<string, string> {
  return {
    [KEYS.chain]: bought.chain,
    [KEYS.from]: bought.from,
    [KEYS.token]: bought.token,
    [KEYS.amount]: bought.amount.toString(),
    [KEYS.usd]: bought.usd.toFixed(2),
    [KEYS.by]: bought.by,
    ...(bought.within ? { [KEYS.within]: "yes" } : {}),
    ...(bought.ahead ? { [KEYS.ahead]: "yes" } : {}),
  };
}

/**
 * The chains' coins a card's purchase trades: the coin it buys, and the coin it pays with where
 * it pays with one. Each is counted from before the move (countBeforeTrading), as a trade's are,
 * so a chain's first look never reads the purchase as money put in or taken out.
 */
export function feeCoinTrades(details: Record<string, string>): FillKey[] {
  const bought = pinned(details);
  if (!bought) return [];
  const paidWith = bought.token === "native" ? [bought.from] : [];
  return [bought.chain, ...paidWith].map((chain) => ({ chain, instrument: "native" }));
}

/** The card with the purchase pinned on it, what execute is held to: no cost (see FeeCoin.usd). */
export function withFeeCoin(preview: ActionPreview, bought: FeeCoin): ActionPreview {
  return { ...preview, details: { ...preview.details, ...feeCoinDetails(bought) } };
}

/** The card without the purchase withFeeCoin pinned on it. */
export function withoutFeeCoin(preview: ActionPreview): ActionPreview {
  if (!pinned(preview.details ?? {})) return preview;
  const keys = new Set<string>(Object.values(KEYS));
  return {
    ...preview,
    details: Object.fromEntries(
      Object.entries(preview.details ?? {}).filter(([key]) => !keys.has(key)),
    ),
  };
}

/**
 * The dollars a card's purchase spends beside the card's own amount, as its card says them
 * ("0.25"), for a specialist's pot. Null for a card that buys none, or whose purchase comes out
 * of what the move itself sends (FeeCoin.within).
 */
export function feeCoinUsd(details: Record<string, string>): string | null {
  const bought = pinned(details);
  return bought && !bought.within ? details[KEYS.usd]! : null;
}

/**
 * The cash a card's purchase spends beside the card's own amount and where, for a plan's sums:
 * its dollars of USDC on the chain that pays. Null where the chain's own coin pays, which is no
 * cash, where it comes out of what the move itself sends, or the card buys none.
 */
export function feeCoinCash(
  details: Record<string, string>,
): { readonly from: NetworkKey; readonly usd: string } | null {
  const bought = pinned(details);
  return bought && bought.token !== "native" && !bought.within
    ? { from: bought.from, usd: details[KEYS.usd]! }
    : null;
}

/**
 * The moves whose card's purchase counts as spent, in SQL: one still running, which may yet buy,
 * and one that kept its purchase (KeptTx.buysFees), however it ended. A move that turned out
 * not to need the coin bought none, and counts nothing.
 */
export const spendsOnFees = sql`(${actions.details} ? ${KEYS.usd} and (
  ${actions.status} = 'running' or exists (
    select 1 from jsonb_array_elements(${actions.txs}) kept where kept ? 'buysFees'
  )
))`;

/** The moves that kept a purchase of `chain`'s coin for their fees, in SQL, however they ended. */
export const boughtFeesFor = (
  chain: string,
) => sql`(${actions.details}->>${KEYS.chain} = ${chain} and exists (
  select 1 from jsonb_array_elements(${actions.txs}) kept where kept ? 'buysFees'
))`;

/**
 * What a card says of the coins its moves buy for network fees, in one quiet line, or null for a
 * card that buys none: what they come to, that most of it stays the owner's (so it is no cost),
 * and the services the money goes through, as its Allow signs those sends too. The one place
 * those words are made, which every drawing of a card and the agent read.
 */
export function feeCoinsSaid(cards: readonly Pick<ActionRow, "details">[]): string | null {
  const bought = cards.flatMap(({ details }) => pinned(details) ?? []);
  if (bought.length === 0) return null;
  const dollars = usdLabel(bought.reduce((sum, { usd }) => sum + usd, 0));
  const coins = listed([...new Set(bought.map((each) => symbol(each.chain)))]);
  const by = listed([...new Set(bought.map((each) => each.by))]);
  return `Also buys about ${dollars} of ${coins} for network fees, most of which stays in your wallet. Bought through ${by}.`;
}

/**
 * What the agent is told a card says of the coin it buys, after the tool that made the card, so
 * it never describes a card as doing less than its Allow signs, nor counts the purchase as lost.
 * Null when it buys none.
 */
export function feeCoinTold(cards: readonly Pick<ActionRow, "details">[]): string | null {
  const said = feeCoinsSaid(cards);
  return (
    said &&
    `The card also says: "${said}" That purchase is not among its costs: what the fees don't use stays in the wallet as that coin, for later moves, so never call it lost to fees.`
  );
}

/**
 * What a move says when the coin its card bought isn't there for it, by where the service says
 * the order stands: what went, to whom, what becomes of it, and what the owner can do. One
 * sentence run a card can show whole (the web shows a reason of up to 200 characters).
 */
export function unpaidSays(bought: FeeCoin, status: PayInStatus): string {
  const { by } = bought;
  const coin = symbol(bought.chain);
  // A swap either bought the coin or sent nothing: there is no order with anyone to stand anywhere.
  if (swaps(bought))
    return `The ${coin} this card bought no longer covers the network fee, and a card buys once. Ask Auni for it again: a new card shows what it buys.`;
  const sent = `the ${paysWith(bought)} this card sent it from ${NETWORKS[bought.from].name}`;
  switch (status) {
    case "pending":
      return `${by} has ${sent} and hasn't paid the ${coin} yet. It pays or refunds by itself. Try again once the ${coin} is there: nothing more is bought.`;
    case "refunded":
      return `${by} refunded ${sent} rather than pay the ${coin}, so the move wasn't sent. Ask Auni for it again: a new card shows what it buys.`;
    case "failed":
      return `${by} has ${sent}, paid no ${coin}, and says it can't refund it by itself. The move wasn't sent. Ask Auni for the order's id to take up with ${by}.`;
    case "success":
      return `The ${coin} this card bought through ${by} no longer covers the network fee, and a card buys once. Ask Auni for it again: a new card shows what it buys.`;
  }
}
