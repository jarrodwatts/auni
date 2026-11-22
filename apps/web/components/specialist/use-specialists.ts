"use client";

import type { SpecialistId, ValueRange } from "@auni/shared";
import { keepPreviousData, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { getSpecialist, getValueHistory, listSpecialists } from "@/lib/data/specialists";
import { getPortfolio } from "@/lib/data/portfolio";
import type { Specialist } from "@/lib/data/views";

/** Nothing in it yet: started but not yet bought. It shows no money until it has some. */
export function holdsNothing(specialist: Specialist): boolean {
  return specialist.value.baseUnits === "0";
}

/** Whether a specialist has money to show beside its conversation. */
export function showsMoney(specialist: Specialist | undefined): boolean {
  return specialist !== undefined && !holdsNothing(specialist);
}

/**
 * How often the money on screen is read again. Core serves it from its last
 * live read at live prices, re-reading the venues only every 15 minutes or
 * once Auni moves money, so a minute costs a price lookup, not a read of every venue.
 */
const MONEY_POLL_MS = 60_000;

export function useSpecialists() {
  return useQuery({
    queryKey: ["specialists"],
    queryFn: ({ signal }) => listSpecialists(signal),
    refetchInterval: MONEY_POLL_MS,
  });
}

/**
 * One specialist by id with its record of what Auni did. The list's copy
 * shows at once; the full read (closed ones included) replaces it.
 */
export function useSpecialist(specialistId: SpecialistId | undefined): {
  readonly specialist: Specialist | undefined;
  readonly loading: boolean;
} {
  const listed = useSpecialists().data?.find(({ id }) => id === specialistId);
  const detail = useQuery({
    queryKey: ["specialist", specialistId],
    queryFn:
      specialistId === undefined ? skipToken : ({ signal }) => getSpecialist(specialistId, signal),
    refetchInterval: MONEY_POLL_MS,
  });
  return { specialist: detail.data ?? listed, loading: detail.isPending && !listed };
}

/**
 * The account (no specialist) or one specialist over a range, read again as
 * often as the money above it so its end and its day keep up. Changing the
 * range keeps the line drawn until the new one arrives.
 */
export function useValueHistory(specialistId: SpecialistId | null, range: ValueRange) {
  return useQuery({
    queryKey: specialistId
      ? ["specialist-history", specialistId, range]
      : ["balance-history", range],
    queryFn: ({ signal }) => getValueHistory(specialistId, range, signal),
    placeholderData: keepPreviousData,
    refetchInterval: MONEY_POLL_MS,
  });
}

/** How often the money is read while a deposit is expected. */
const DEPOSIT_POLL_MS = 10_000;

/**
 * The account's total and loose money; a failed read retries when the window
 * regains focus. While a deposit is expected it is read every 10 seconds,
 * each read having core look for money that landed, so it shows within
 * about two reads of arriving.
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

/** Every read of the account's money, by the first part of its key. */
const MONEY_READS = [
  "specialists",
  "specialist",
  "specialist-history",
  "portfolio",
  "balance-history",
  "withdraw-cash",
  "activity",
] as const;

/**
 * Re-reads the specialists and the money around them after Auni may have
 * moved some: the total, cash and holdings, the lines behind them, and activity.
 */
export function useRefreshSpecialists() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    for (const read of MONEY_READS) void queryClient.invalidateQueries({ queryKey: [read] });
  }, [queryClient]);
}
