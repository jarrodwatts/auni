import type { ActionStatus } from "@auni/shared";

/**
 * How a card that ended before the owner allowed any of it says so, or null for one that
 * didn't: a newer card took its place, Auni took it back (core says why, in its RETRACTED
 * words), or the owner said not now.
 */
export function untapped(
  legs: readonly { readonly status: ActionStatus; readonly error: string | null }[],
): string | null {
  if (legs.some(({ status }) => status === "replaced")) return "Updated below";
  const retracted = legs.find(({ status }) => status === "retracted");
  if (retracted) return retracted.error ?? "Taken back by Auni";
  if (legs.length > 0 && legs.every(({ status }) => status === "cancelled"))
    return "You said not now";
  return null;
}
