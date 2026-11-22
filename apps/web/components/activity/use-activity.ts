"use client";

import type { ActivityWire, ThreadId } from "@auni/shared";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getActivity, markActivitySeen } from "@/lib/data/activity";

const ACTIVITY_POLL_MS = 5 * 60_000;

/**
 * The person's activity, everything or what one thread took part in.
 * Switching between them keeps the last list on screen until the next lands.
 */
export function useActivity(only: ThreadId | null = null) {
  return useQuery({
    queryKey: ["activity", only],
    queryFn: ({ signal }) => getActivity(only, signal),
    placeholderData: keepPreviousData,
    refetchInterval: ACTIVITY_POLL_MS,
  });
}

export function useSeeActivity(activity: ActivityWire | undefined): ReadonlySet<string> {
  const queryClient = useQueryClient();
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const newly = (activity?.items ?? []).filter((item) => item.unread && !fresh.has(item.id));
  if (newly.length > 0) setFresh(new Set([...fresh, ...newly.map((item) => item.id)]));
  const unread = activity?.unread ?? 0;
  useEffect(() => {
    if (unread === 0) return;
    void markActivitySeen().then(
      () =>
        queryClient.setQueriesData<ActivityWire>({ queryKey: ["activity"] }, (read) =>
          read ? { ...read, unread: 0 } : read,
        ),
      () => undefined,
    );
  }, [queryClient, unread]);
  return fresh;
}
