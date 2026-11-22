"use client";

import type { ActivityWire, SpecialistId } from "@auni/shared";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { getActivity, markActivitySeen } from "@/lib/data/activity";

/**
 * How often activity is read again, for the sidebar's count. What it counts
 * (a venue acting by itself, money arriving) is rare, and every move of
 * Auni's reads it again at once (see useRefreshSpecialists).
 */
const ACTIVITY_POLL_MS = 5 * 60_000;

/**
 * The person's activity, everything or what one specialist took part in.
 * Switching between them keeps the last list on screen until the next lands.
 */
export function useActivity(only: SpecialistId | null = null) {
  return useQuery({
    queryKey: ["activity", only],
    queryFn: ({ signal }) => getActivity(only, signal),
    placeholderData: keepPreviousData,
    refetchInterval: ACTIVITY_POLL_MS,
  });
}

/**
 * While the person is looking at their activity, whatever it shows unread is
 * seen: core is told, and every count of it clears at once. Returns what was
 * unread when it came into view, so this visit can still say which was new.
 */
export function useSeeActivity(activity: ActivityWire | undefined): ReadonlySet<string> {
  const queryClient = useQueryClient();
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  // Kept as it shows, before the next read comes back with it seen.
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
      // The count stays until the next look; nothing here is worth an error.
      () => undefined,
    );
  }, [queryClient, unread]);
  return fresh;
}
