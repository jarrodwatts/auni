"use client";

import type { ThreadId, ValueRange } from "@auni/shared";
import { keepPreviousData, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { getPortfolio, getValueHistory } from "@/lib/data/portfolio";
import { getTakes } from "@/lib/data/takes";
import { getThreadState } from "@/lib/data/threads";

/**
 * How often the money on screen is read again. Core serves it from its last
 * live read at live prices, re-reading the venues only every 15 minutes or
 * once Auni moves money, so a minute costs a price lookup, not a read of every venue.
 */
export const MONEY_POLL_MS = 60_000;

/**
 * Total account value over a range, read again as often as the money above it
 * so its end and its day keep up. Changing the range keeps the line drawn until
 * the new one arrives.
 */
export function useValueHistory(range: ValueRange) {
  return useQuery({
    queryKey: ["balance-history", range],
    queryFn: ({ signal }) => getValueHistory(range, signal),
    placeholderData: keepPreviousData,
    refetchInterval: MONEY_POLL_MS,
  });
}

/** How often the money is read while a deposit is expected. */
const DEPOSIT_POLL_MS = 10_000;

/**
 * The account's live total, holdings, and cash; a failed read retries when the
 * window regains focus. While a deposit is expected it is read every 10 seconds,
 * each read having core look for money that landed.
 */
export function usePortfolio(depositExpected = false) {
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: ({ signal }) => getPortfolio(signal, depositExpected),
    refetchInterval: depositExpected ? DEPOSIT_POLL_MS : MONEY_POLL_MS,
    refetchOnWindowFocus: (query) => query.state.status === "error",
    refetchOnReconnect: (query) => query.state.status === "error",
  });
}

/**
 * Every take with its share of the money, what that is worth and what it made, and what no
 * take holds: read as often as the money, which it splits.
 */
export function useTakes() {
  return useQuery({
    queryKey: ["takes"],
    queryFn: ({ signal }) => getTakes(signal),
    refetchInterval: MONEY_POLL_MS,
    refetchOnWindowFocus: (query) => query.state.status === "error",
  });
}

/** Live holdings opened in one thread and its remaining auto-spend budget. */
export function useThreadState(threadId: ThreadId | undefined) {
  return useQuery({
    queryKey: ["thread-state", threadId],
    queryFn: threadId === undefined ? skipToken : ({ signal }) => getThreadState(threadId, signal),
    refetchInterval: MONEY_POLL_MS,
  });
}

/** Every read of the account's money, by the first part of its key. */
const MONEY_READS = [
  "portfolio",
  "takes",
  "balance-history",
  "thread-state",
  "withdraw-cash",
  "activity",
] as const;

/**
 * Re-reads the portfolio, thread holdings, charts, and activity after Auni may
 * have moved money.
 */
export function useRefreshMoney() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    for (const read of MONEY_READS) void queryClient.invalidateQueries({ queryKey: [read] });
  }, [queryClient]);
}
