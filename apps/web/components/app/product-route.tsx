"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { AuthenticatedProduct } from "@/components/auth/authenticated-product";
import { OwnerGate } from "@/components/auth/owner-gate";
import { Waking } from "@/components/landing/landing";

/** Where first run is: a new chat, which is the first take until it's sent. */
const FIRST_RUN = "/app/new";

/**
 * The product, for the owner's browser once core has said it is theirs. Until their first take
 * is sent, every page of it is that take's question (FirstRunTake, at /app/new).
 */
export function ProductRoute({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  return (
    <OwnerGate>
      {(owner) =>
        owner.welcomed || pathname === FIRST_RUN ? (
          <AuthenticatedProduct me={owner}>{children}</AuthenticatedProduct>
        ) : (
          <ToFirstRun />
        )
      }
    </OwnerGate>
  );
}

function ToFirstRun() {
  const router = useRouter();
  useEffect(() => router.replace(FIRST_RUN), [router]);
  return <Waking />;
}
