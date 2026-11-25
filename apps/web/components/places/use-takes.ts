"use client";

import type { ThreadId } from "@auni/shared";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { MONEY_POLL_MS } from "@/components/portfolio/use-portfolio";
import { getThreadState } from "@/lib/data/threads";
import type { Holding, Thread, ThreadState } from "@/lib/data/views";

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
  return value > 0n ? { value, change } : null;
}

/** A take is a chat that moved money, which the thread list says before any value is read. */
export const isTake = (thread: Thread) => thread.moveCount > 0;

/**
 * Every take's value, by thread, each from the same read as its inspector: absent until its read
 * lands, null once read when it holds nothing now. (Core's `GET /takes`, once there, answers this
 * in one read.)
 */
export function useTakes(threads: readonly Thread[]): ReadonlyMap<ThreadId, TakeValue | null> {
  const moved = useMemo(() => threads.filter(isTake), [threads]);
  const combine = useCallback(
    (states: readonly { readonly data?: ThreadState }[]) => {
      const takes = new Map<ThreadId, TakeValue | null>();
      moved.forEach((thread, index) => {
        const holdings = states[index]?.data?.holdings;
        if (holdings) takes.set(thread.id, takeValue(holdings));
      });
      return takes;
    },
    [moved],
  );
  return useQueries({
    queries: moved.map((thread) => ({
      queryKey: ["thread-state", thread.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => getThreadState(thread.id, signal),
      refetchInterval: MONEY_POLL_MS,
    })),
    combine,
  });
}
