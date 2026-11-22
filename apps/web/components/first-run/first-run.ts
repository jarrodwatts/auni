import type { BrainsWire } from "@auni/shared";

/** The first of the owner's AIs that can think now, or null while none can. */
export function readyBrain(
  rows: BrainsWire["rows"],
): { readonly id: string; readonly name: string } | null {
  const found = rows.find(({ row }) => row.state === "ready" || row.state === "resting");
  return found ? { id: found.row.id, name: found.row.name } : null;
}

/**
 * Known to have no AI that can think, which the owner can fix from the app: a take sent now is
 * answered only by Auni asking for one (core's noBrain). Unknown is never that.
 */
export function nothingThinks(brains: BrainsWire | undefined): boolean {
  return brains !== undefined && brains.blocked === null && readyBrain(brains.rows) === null;
}
