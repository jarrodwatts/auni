import type { Me } from "@auni/shared";

/** Where Auni runs, as the owner reads it: its machine's name when reached from elsewhere. */
export function whereAuniRuns(reach: Me["reach"]): string {
  return reach.through === "tailscale" ? reach.machine : "this computer";
}
