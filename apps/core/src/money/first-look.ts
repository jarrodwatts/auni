import { NETWORK_KEYS } from "@auni/shared";
import { inArray, sql } from "drizzle-orm";

import { lockOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { firstLooks, otherTokens } from "../db/schema.ts";
import { accountOf, isSavings } from "../apps/registry.ts";
import { fillIdentity } from "./fill-key.ts";
import { startCounting } from "./other-tokens.ts";
import type { Holding } from "./portfolio.ts";

/**
 * Money the owner already had when Auni first looked is money put in, never made: whatever a
 * look finds that nothing of Auni's counts yet is kept at its worth then (other_tokens), so
 * "made" reads nothing on the day a wallet is brought, and moves only by price and trading
 * after. Plain cash needs none: it is worth just what was put in (see madeUsd).
 *
 *   the wallet on a chain   no RPC lists what a wallet holds, so each token is looked at on
 *                           its own, the first time anything reads it: a read of the portfolio,
 *                           the sweep's first look (countWhatWasThere), a move about to trade
 *                           it, or money moving in or out of it. Each is read at a block, so
 *                           what moved after it counts as it moved (see startCounting).
 *   an app's account        its read lists everything it holds, so its first look, a read
 *                           of the portfolio or a move about to run there, counts all of it.
 *                           After that a holding there comes and goes by trades, which its
 *                           fills count, or between it and the account's own cash.
 *
 * A new app's account needs nothing of its own: whatever it reports goes through here.
 */

/**
 * A place Auni reads money at, by name: the owner's wallet on a chain ("wallet monad"), or an
 * app's account, kept in a ledger of its own (by the app's id) or on a chain ("<app id>
 * <chain>"). An account's place is the name the portfolio reads it by.
 */
export function placeOf(venue: string, chain: string): string {
  if (venue === "wallet") return `wallet ${chain}`;
  return venue === chain ? venue : `${venue} ${chain}`;
}

/** Whether this holding is kept outside the owner's wallet, at an app's account (see Account.kept). */
function keptOutside(holding: Pick<Holding, "venue">): boolean {
  const kept = holding.venue === "wallet" ? undefined : accountOf(holding.venue)?.account.kept;
  return kept !== undefined && !("wallet" in kept);
}

/** Which of these places Auni has looked at once. */
export async function lookedAt(places: readonly string[]): Promise<Set<string>> {
  if (places.length === 0) return new Set();
  const rows = await db
    .select({ place: firstLooks.place })
    .from(firstLooks)
    .where(inArray(firstLooks.place, [...places]));
  return new Set(rows.map(({ place }) => place));
}

/** Marks these places looked at. */
export async function markLooked(places: readonly string[]): Promise<void> {
  if (places.length === 0) return;
  await db
    .insert(firstLooks)
    .values(places.map((place) => ({ place })))
    .onConflictDoNothing();
}

/**
 * The owner's wallets whose first look isn't made yet, by network: until it is, holdings
 * there may be missing from the portfolio (see countWhatWasThere).
 */
export async function stillLooking(wallets: {
  readonly evm: string | null;
  readonly solana: string | null;
}): Promise<string[]> {
  const ours = NETWORK_KEYS.filter((chain) => (chain === "solana" ? wallets.solana : wallets.evm));
  const looked = await lookedAt(ours.map((chain) => placeOf("wallet", chain)));
  return ours.filter((chain) => !looked.has(placeOf("wallet", chain)));
}

/**
 * Counts what a read found as Auni's first look at it, where it is one: `holdings` as read,
 * `places` the accounts whose read came back whole, and `counted` what Auni counts already. A
 * holding with no price is left for a read that can value it. Throws while a
 * wallet token can't be read at a block or valued, so the read that found it is kept as no
 * reading (see readPortfolio).
 */
export async function countFirstLook(
  holdings: readonly Holding[],
  places: readonly string[],
  counted: ReadonlySet<string>,
): Promise<void> {
  const fresh = holdings.filter(
    (holding) =>
      holding.usdValue !== null &&
      !(holding.cash && !isSavings(holding.venue)) &&
      !counted.has(fillIdentity(holding)),
  );
  const inWallet = fresh.filter((holding) => !keptOutside(holding));
  await Promise.all(
    [...Map.groupBy(inWallet, ({ chain }) => chain)].map(([chain, on]) =>
      startCounting(
        chain as (typeof NETWORK_KEYS)[number],
        on.map(({ instrument }) => instrument),
      ),
    ),
  );
  // A place holding something Auni can't value yet is looked at by a read that can.
  const unvalued = new Set(
    holdings.flatMap((holding) =>
      holding.usdValue === null ? [placeOf(holding.venue, holding.chain)] : [],
    ),
  );
  const looked = await lookedAt(places);
  const first = places.filter((place) => !looked.has(place) && !unvalued.has(place));
  if (first.length === 0) return;
  await db.transaction(async (tx) => {
    // The owner's row, as startCounting takes it, so two reads at once make one first look.
    await lockOwner(tx);
    const marked = await tx
      .insert(firstLooks)
      .values(first.map((place) => ({ place })))
      .onConflictDoNothing()
      .returning({ place: firstLooks.place });
    const now = new Set(marked.map(({ place }) => place));
    const found = fresh.filter(
      (holding) => keptOutside(holding) && now.has(placeOf(holding.venue, holding.chain)),
    );
    if (found.length === 0) return;
    await tx
      .insert(otherTokens)
      .values(
        found.map(({ chain, instrument, usdValue }) => ({
          chain,
          instrument,
          keptAt: sql`now()`,
          keptUsd: usdValue,
        })),
      )
      .onConflictDoNothing();
  });
}
