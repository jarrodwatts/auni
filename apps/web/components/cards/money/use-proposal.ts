"use client";

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";

import { RUNNING_POLL_MS, tapFailed } from "@/lib/data/actions";
import { decideProposal, getProposal, type LiveProposal } from "@/lib/data/proposals";

type Decision = "allow" | "decline";

/**
 * A proposal card's live read and its one tap. It reads again every 2 seconds
 * while a leg runs, and otherwise as `poll` says (by default, not at all). A
 * tap whose answer is lost may have gone through regardless, so the card
 * reads the proposal again and says it couldn't confirm.
 */
export function useProposal(
  proposalId: string,
  poll?: (data: LiveProposal | undefined) => number | false,
): {
  readonly live: UseQueryResult<LiveProposal>;
  readonly queryKey: readonly unknown[];
  readonly decide: (decision: Decision) => Promise<void>;
  /** The tap on its way to core. */
  readonly pending: Decision | null;
  readonly error: string | null;
} {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryKey = ["proposal", proposalId];
  const live = useQuery({
    queryKey,
    queryFn: ({ signal }) => getProposal(proposalId, signal),
    refetchInterval: (query) =>
      // A held leg has stopped, and waits on the person, not on the next read.
      query.state.data?.legs.some((leg) => leg.status === "running" && !leg.held)
        ? RUNNING_POLL_MS
        : (poll?.(query.state.data) ?? false),
  });

  const decide = async (decision: Decision) => {
    setPending(decision);
    setError(null);
    try {
      queryClient.setQueryData<LiveProposal>(queryKey, await decideProposal(proposalId, decision));
    } catch (caught) {
      void queryClient.invalidateQueries({ queryKey });
      setError(tapFailed(caught));
    } finally {
      setPending(null);
    }
  };

  return { live, queryKey, decide, pending, error };
}
