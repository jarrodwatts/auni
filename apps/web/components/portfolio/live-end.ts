import type { BalanceHistoryPoint } from "@/lib/data/views";
import { usdc } from "@/lib/data/usdc";

import type { MadeReading } from "./made-change";

/** The number on screen now: its value and what it has made, in base units. */
export type LiveValue = Omit<MadeReading, "at">;

/**
 * A history that ends in the number on screen, so its line ends there too.
 * Core draws a line from its readings, read apart from the number, and a
 * reading can lag it: none is kept until a move or a deposit has settled,
 * a few minutes after the number shows it, and a month or longer ends at its
 * last reading. A history with nothing in it stays empty.
 */
export function endingLive(
  history: readonly BalanceHistoryPoint[],
  live: LiveValue | null,
  now = Date.now(),
): readonly BalanceHistoryPoint[] {
  const last = history.at(-1);
  if (!last || !live) return history;
  // Never before the history's own end, should this clock run behind core's.
  const at = Math.max(now, Date.parse(last.observedAt));
  return [
    ...history,
    { observedAt: new Date(at).toISOString(), totalUsd: usdc(live.value), made: usdc(live.made) },
  ];
}
