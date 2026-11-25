"use client";

import type { ThreadId } from "@auni/shared";
import { useMemo } from "react";

import { useTakes } from "@/components/portfolio/use-portfolio";
import type { Holding } from "@/lib/data/views";

/** What a take holds now, and how that moved over the last day. */
export interface TakeValue {
  /** USDC base units. */
  readonly value: bigint;
  /** Signed USDC base units over the last 24 hours; null when a holding's history wasn't readable. */
  readonly change: bigint | null;
}

/**
 * A thread's holdings as one take: their value summed, and their day's change summed only when
 * every holding's is known, as a part of it would understate the move. Null when it holds nothing.
 */
export function takeValue(holdings: readonly Holding[]): TakeValue | null {
  let value = 0n;
  let change: bigint | null = 0n;
  for (const holding of holdings) {
    value += BigInt(holding.value.baseUnits);
    change =
      change === null || holding.todayChangeBaseUnits === null
        ? null
        : change + BigInt(holding.todayChangeBaseUnits);
  }
  return holdings.length > 0 ? { value, change } : null;
}

/**
 * Each take's worth and its day, by thread, from core's `GET /takes`: Money's one rule for what a
 * take is, a chat whose own fills still hold something, savings among them. Undefined until it
 * is first read; empty when that read failed, so every chat still has a place.
 */
export function useTakeValues(): ReadonlyMap<ThreadId, TakeValue> | undefined {
  const { data, isError } = useTakes();
  return useMemo(() => {
    if (!data) return isError ? new Map() : undefined;
    return new Map(
      data.takes.map((take) => [
        take.threadId,
        { value: take.value, change: takeValue(take.holdings)?.change ?? null },
      ]),
    );
  }, [data, isError]);
}
