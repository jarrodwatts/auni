"use client";

import type { Me } from "@auni/shared";
import type { ReactNode } from "react";

import { HandedOverNotice, OwnerNotice } from "@/components/auth/owner-notice";
import { useOwner } from "@/components/auth/owner-provider";
import { Waking } from "@/components/auth/waking";

/** What only the owner's browser sees, once core has said it is theirs; else why not, plainly. */
export function OwnerGate({ children }: { readonly children: (owner: Me) => ReactNode }) {
  const { state } = useOwner();
  switch (state.status) {
    case "paired":
      return children(state.owner);
    // While core says whose browser this is (and spends a pairing link on the way).
    case "loading":
      return <Waking />;
    case "starting":
      return <Waking step="starting" />;
    case "handed-over":
      return <HandedOverNotice to={state.to} machine={state.machine} />;
    default:
      return <OwnerNotice reason={state.status} />;
  }
}
