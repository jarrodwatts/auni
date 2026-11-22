"use client";

import type { Me } from "@auni/shared";
import type { ReactNode } from "react";

import { HandedOverNotice, OwnerNotice } from "@/components/auth/owner-notice";
import { useOwner } from "@/components/auth/owner-provider";
import { Waking } from "@/components/landing/landing";

/** What only the owner's browser sees, once core has said it is theirs; else why not, plainly. */
export function OwnerGate({ children }: { readonly children: (owner: Me) => ReactNode }) {
  const { state, retry } = useOwner();
  if (state.status === "paired") return children(state.owner);
  // While core says whose browser this is (and spends a pairing link on the way): Auni waking.
  if (state.status === "loading") return <Waking />;
  if (state.status === "handed-over")
    return <HandedOverNotice to={state.to} machine={state.machine} />;
  return <OwnerNotice reason={state.status} onRetry={retry} />;
}
