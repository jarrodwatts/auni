"use client";

import { useCallback } from "react";

import { useOwner } from "@/components/auth/owner-provider";
import { useSetupStep } from "@/lib/data/setup";

/**
 * First run's two parts in sending the owner's first take (see startInOrder). Before its chat
 * starts, core makes the wallet they didn't bring and marks them welcomed (again on a retry,
 * which keeps what the first try made). Once the chat is there, the app opens around it as the
 * owner's. Both do nothing once first run is over.
 */
export function useFirstTake(): {
  readonly finish: () => Promise<void>;
  readonly welcome: () => void;
} {
  const { state, setOwner } = useOwner();
  const { mutateAsync } = useSetupStep();
  const owner = state.status === "paired" && !state.owner.welcomed ? state.owner : null;
  const finish = useCallback(async () => {
    if (owner) await mutateAsync({ path: "setup/done" });
  }, [owner, mutateAsync]);
  // The rest of what /setup/done changed (the wallet's addresses) reaches the owner's one copy
  // by the live "me" topic it publishes.
  const welcome = useCallback(() => {
    if (owner) setOwner({ ...owner, welcomed: true });
  }, [owner, setOwner]);
  return { finish, welcome };
}
