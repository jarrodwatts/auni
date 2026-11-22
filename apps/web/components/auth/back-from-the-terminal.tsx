"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useOwner } from "@/components/auth/owner-provider";
import { endTerminalTrip } from "@/lib/terminal-trip";

/**
 * Ends a trip to the terminal (lib/terminal-trip.ts) in the tab its pairing link opened: back to
 * the page the owner was sent from, where what they were doing waits. Draws nothing itself.
 */
export function BackFromTheTerminal() {
  const { pairedHere } = useOwner();
  const router = useRouter();

  useEffect(() => {
    if (!pairedHere) return;
    const path = endTerminalTrip();
    if (path && path !== window.location.pathname + window.location.search) router.replace(path);
  }, [pairedHere, router]);

  return null;
}
