import type { ActivityItemWire } from "@auni/shared";

import type { Holding } from "@/lib/data/views";

/**
 * Holdings no take holds, split into the ones worth a row and the crumbs: anything under 1% of
 * all the money, which a gas coin or the dust a sale leaves usually is, folds into one quiet row.
 */
export function splitDust(
  holdings: readonly Holding[],
  totalBaseUnits: bigint,
): { readonly shown: readonly Holding[]; readonly dust: readonly Holding[] } {
  const small = (holding: Holding) => BigInt(holding.value.baseUnits) * 100n < totalBaseUnits;
  return {
    shown: holdings.filter((holding) => !small(holding)),
    dust: holdings.filter(small),
  };
}

/** What the owner can narrow Recent to. */
export const RECENT_FILTERS = [
  { value: "all", name: "All" },
  { value: "trades", name: "Trades" },
  { value: "transfers", name: "In and out" },
] as const;

export type RecentFilter = (typeof RECENT_FILTERS)[number]["value"];

/**
 * Whether an item is money coming in or going out of the owner's wallet (a deposit, or a
 * withdrawal Auni sent), or a trade: what Auni bought, sold or moved, and what a venue did.
 */
function isTransfer(item: ActivityItemWire): boolean {
  return item.kind === "arrival" || item.amount?.direction === "out";
}

export function recentOf(
  items: readonly ActivityItemWire[],
  filter: RecentFilter,
): readonly ActivityItemWire[] {
  if (filter === "all") return items;
  return items.filter((item) => isTransfer(item) === (filter === "transfers"));
}

/** How many of a take's moves its timeline shows: the latest, oldest of them first. */
const TIMELINE_MOVES = 4;

/**
 * The moves that built a take, oldest first, as many as its timeline shows (the latest), and
 * how many earlier ones it leaves out.
 */
export function takeTimeline(
  items: readonly ActivityItemWire[],
  threadId: string,
): { readonly moves: readonly ActivityItemWire[]; readonly earlier: number } {
  // Items come newest first.
  const mine = items.filter((item) => item.threadId === threadId);
  return {
    moves: mine.slice(0, TIMELINE_MOVES).toReversed(),
    earlier: Math.max(0, mine.length - TIMELINE_MOVES),
  };
}
