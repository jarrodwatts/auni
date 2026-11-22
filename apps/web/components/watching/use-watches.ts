"use client";

import type { AutomationRuleId, AutomationWire } from "@auni/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  deleteWatch,
  listWatchFires,
  listWatches,
  setWatchPaused,
  type WatchScope,
} from "@/lib/data/automations";

function scopeKey(scope: WatchScope): string {
  return `thread:${scope.threadId}`;
}

/** What Auni watches for a thread, paused ones included. */
export function useWatches(scope: WatchScope) {
  return useQuery({
    queryKey: ["watches", scopeKey(scope)],
    queryFn: ({ signal }) => listWatches(scope, signal),
  });
}

/** When those watches fired and the line Auni opened with, newest first. */
export function useWatchFires(scope: WatchScope, wanted: boolean) {
  return useQuery({
    queryKey: ["watch-fires", scopeKey(scope)],
    queryFn: ({ signal }) => listWatchFires(scope, signal),
    enabled: wanted,
  });
}

/** A switch flips at once; a failed save puts it back and says so. */
export function useSetWatchPaused() {
  const queryClient = useQueryClient();
  const replace = (next: Pick<AutomationWire, "id" | "status">) =>
    queryClient.setQueriesData<AutomationWire[]>({ queryKey: ["watches"] }, (list) =>
      list?.map((watch) => (watch.id === next.id ? { ...watch, status: next.status } : watch)),
    );
  return useMutation({
    mutationFn: (input: { readonly id: AutomationRuleId; readonly paused: boolean }) =>
      setWatchPaused(input.id, input.paused),
    onMutate: ({ id, paused }) => replace({ id, status: paused ? "paused" : "active" }),
    onSuccess: replace,
    onError: () => {
      toast.error("That didn't save. Try again.");
      void queryClient.invalidateQueries({ queryKey: ["watches"] });
    },
  });
}

/** A deleted watch leaves the list at once; a failed delete puts it back and says so. */
export function useDeleteWatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: AutomationRuleId) => deleteWatch(id),
    onMutate: (id) =>
      queryClient.setQueriesData<AutomationWire[]>({ queryKey: ["watches"] }, (list) =>
        list?.filter((watch) => watch.id !== id),
      ),
    onError: () => toast.error("That didn't delete. Try again."),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["watches"] }),
  });
}

/** Watches that are on or switched off; ones that ran their course are left out. */
export function liveWatches(watches: readonly AutomationWire[]): AutomationWire[] {
  return watches.filter(({ status }) => status === "active" || status === "paused");
}
