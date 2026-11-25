"use client";

import { LoaderCircle } from "lucide-react";

import { Lockup } from "@/components/brand/lockup";

/** Calm loading screen shown while core verifies the owner's browser session. */
export function Waking() {
  return (
    <main
      id="main-content"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-6"
    >
      <Lockup height={24} priority />
      <div role="status" className="flex items-center gap-2 text-meta text-muted-foreground">
        <LoaderCircle aria-hidden className="size-4 animate-spin text-faint" />
        <span>Waking up…</span>
      </div>
    </main>
  );
}
