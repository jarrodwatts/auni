"use client";

import type { AddWatchedWalletRequest, Me, UpdateMeRequest } from "@auni/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  addMissingKey,
  addWatchedWallet,
  refreshOwnerSignals,
  removeWatchedWallet,
  updateMe,
} from "@/lib/data/me";

/** The one copy of the owner, which ClientDataProvider seeds with what OwnerProvider read. */
export const ME_KEY = ["me"] as const;

/** The owner as core last said: their name, time zone, wallets, brain and chat apps. */
export function useMe(): Me {
  const { data } = useQuery<Me>({ queryKey: ME_KEY });
  if (!data) throw new Error("useMe is read inside the paired product, which seeds it.");
  return data;
}

/** Reads the owner again, for what changes outside the app (a login, a pairing, new keys). */
export function useRefreshMe(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => void queryClient.invalidateQueries({ queryKey: ME_KEY }), [queryClient]);
}

/** Saves a change, and writes core's answer back as the one copy. */
export function useUpdateMe() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (update: UpdateMeRequest) => updateMe(update),
    onSuccess: (me: Me) => queryClient.setQueryData(ME_KEY, me),
  });
}

/** Makes the key the wallet lacks beside the one it holds, and writes core's answer back. */
export function useAddMissingKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addMissingKey,
    onSuccess: (me: Me) => queryClient.setQueryData(ME_KEY, me),
  });
}

/** Adds a watch-only public wallet address and writes core's updated owner record back. */
export function useAddWatchedWallet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AddWatchedWalletRequest) => addWatchedWallet(input),
    onSuccess: (me: Me) => queryClient.setQueryData(ME_KEY, me),
  });
}

/** Removes a watch-only public wallet address and writes core's updated owner record back. */
export function useRemoveWatchedWallet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => removeWatchedWallet(address),
    onSuccess: (me: Me) => queryClient.setQueryData(ME_KEY, me),
  });
}

/** Triggers a fresh background read of X handle and watch-only wallet holdings. */
export function useRefreshSignals() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: refreshOwnerSignals,
    onSuccess: (me: Me) => queryClient.setQueryData(ME_KEY, me),
  });
}
