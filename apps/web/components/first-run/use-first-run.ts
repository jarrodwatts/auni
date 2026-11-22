"use client";

import { useOwner } from "@/components/auth/owner-provider";

/** The owner hasn't sent their first take yet: the app is only its question. */
export function useFirstRun(): boolean {
  const { state } = useOwner();
  return state.status === "paired" && !state.owner.welcomed;
}
