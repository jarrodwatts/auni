import type { ActivityItemWire } from "@auni/shared";

import type { Holding } from "@/lib/data/views";

/** The most a crumb is worth, in USDC base units ($25), however much money there is. */
const DUST_MOST = 25_000_000n;

/**
 * Holdings no take holds, split into the ones worth a row and the crumbs: anything under both 1%
 * of all the money and $25, which a gas coin or the dust a sale leaves usually is, folds into one
 * quiet row. On a large account 1% is real money ($950 of $95,000), so it keeps its own row.
 */
export function splitDust(
  holdings: readonly Holding[],
  totalBaseUnits: bigint,
): { readonly shown: readonly Holding[]; readonly dust: readonly Holding[] } {
  const small = (holding: Holding) => {
    const value = BigInt(holding.value.baseUnits);
    return value * 100n < totalBaseUnits && value < DUST_MOST;
  };
  return {
    shown: holdings.filter((holding) => !small(holding)),
    dust: holdings.filter(small),
  };
}

/**
 * What Money opens on: the first-use prompt only for an owner with nothing and no past (no
 * balance and not one move), never for one who withdrew it all, whose receipts stay in Recent;
 * a wait while the moves are still loading. Moves that couldn't be read (null) can't say there
 * are none, so the page shows, with Recent saying it couldn't load them.
 */
export function moneyView(
  empty: boolean,
  moves: readonly ActivityItemWire[] | null | undefined,
): "first-use" | "overview" | "waiting" {
  if (!empty || moves === null) return "overview";
  if (moves === undefined) return "waiting";
  return moves.length === 0 ? "first-use" : "overview";
}

/** What the owner can narrow Recent to. */
export const RECENT_FILTERS = [
  { value: "all", name: "All" },
  { value: "trades", name: "Trades" },
  { value: "transfers", name: "In and out" },
] as const;

export type RecentFilter = (typeof RECENT_FILTERS)[number]["value"];

/** Recent narrowed to what each item is, as core says (see the wire's `category`). */
export function recentOf(
  items: readonly ActivityItemWire[],
  filter: RecentFilter,
): readonly ActivityItemWire[] {
  if (filter === "all") return items;
  const category = filter === "trades" ? "trade" : "transfer";
  return items.filter((item) => item.category === category);
}

/** A move as a bead on the Money line, and whether its note is written beside it. */
export interface ChartMove {
  readonly item: ActivityItemWire;
  readonly at: number;
  readonly noted: boolean;
}

/** How many notes the Money line writes: the chart has room for two. */
const CHART_NOTES = 2;

/**
 * The moves on the Money line, oldest first: each one from `from` (the line's first reading) on.
 * Money in or out lifts or drops the line as a gain or a loss would, so the largest deposits or
 * withdrawals in the period (two at most) are written on the chart, to say the line moved
 * because money came or went, not because it was made or lost.
 */
export function chartMoves(items: readonly ActivityItemWire[], from: number): ChartMove[] {
  const shown = items
    .map((item) => ({ item, at: Date.parse(item.at) }))
    .filter(({ at }) => at >= from)
    .toSorted((a, b) => a.at - b.at);
  const noted = new Set(
    shown
      .filter(({ item }) => item.category === "transfer" && item.amount)
      .toSorted((a, b) => Number(b.item.amount!.usd) - Number(a.item.amount!.usd))
      .slice(0, CHART_NOTES)
      .map(({ item }) => item.id),
  );
  return shown.map((move) => ({ ...move, noted: noted.has(move.item.id) }));
}

/** How many of a take's moves its timeline shows: the latest, oldest of them first. */
const TIMELINE_MOVES = 4;

/**
 * The moves that built a take (its own activity, newest first), oldest first, as many as its
 * timeline shows (the latest), and how many earlier ones it leaves out.
 */
export function takeTimeline(items: readonly ActivityItemWire[]): {
  readonly moves: readonly ActivityItemWire[];
  readonly earlier: number;
} {
  return {
    moves: items.slice(0, TIMELINE_MOVES).toReversed(),
    earlier: Math.max(0, items.length - TIMELINE_MOVES),
  };
}
