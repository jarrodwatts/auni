"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useOwner } from "@/components/auth/owner-provider";

/**
 * Core ends first run as the owner's first chat is made (making the wallet they didn't bring with
 * it). Once that chat is there, this opens the app around it as the owner's: it mirrors core into
 * the owner's one copy, and first run's facts (the wallet just made) are read again. Does nothing
 * once first run is over.
 */
export function useWelcome(): () => void {
  const { state, setOwner } = useOwner();
  const queryClient = useQueryClient();
  const owner = state.status === "paired" && !state.owner.welcomed ? state.owner : null;
  return useCallback(() => {
    if (!owner) return;
    setOwner({ ...owner, welcomed: true });
    void queryClient.invalidateQueries({ queryKey: ["setup"] });
  }, [owner, setOwner, queryClient]);
}
