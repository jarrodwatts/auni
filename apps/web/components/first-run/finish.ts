"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { useOwner } from "@/components/auth/owner-provider";
import { ME_KEY } from "@/components/personalization/use-me";
import { getMe } from "@/lib/data/me";
import { useSetupStep } from "@/lib/data/setup";

import { useFirstRun } from "./use-first-run";

/**
 * Finishes first run as the owner's first take is sent: core makes the wallet they didn't bring
 * and marks them welcomed, then the app opens around the take as the owner's. Does nothing once
 * first run is over. Throws when core didn't take it, so the take stays in its box to send again.
 */
export function useFinishFirstRun(): () => Promise<void> {
  const firstRun = useFirstRun();
  const { mutateAsync } = useSetupStep();
  const { setOwner } = useOwner();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    if (!firstRun) return;
    await mutateAsync({ path: "setup/done" });
    const owner = await getMe();
    queryClient.setQueryData(ME_KEY, owner);
    setOwner(owner);
  }, [firstRun, mutateAsync, queryClient, setOwner]);
}
