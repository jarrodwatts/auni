import type { PlaceKey } from "@/lib/data/places";
import type { Specialist, Thread } from "@/lib/data/views";

/**
 * The specialists as listed: open ones in core's order, then closed ones
 * until their conversation is archived, the latest to move first.
 */
export function listedSpecialists(
  specialists: readonly Specialist[],
  byPlace: ReadonlyMap<PlaceKey, Thread>,
): readonly Specialist[] {
  const movedAt = (id: Specialist["id"]) => Date.parse(byPlace.get(id)?.updatedAt ?? "") || 0;
  const open = specialists.filter(({ status }) => status !== "retired");
  const closed = specialists
    .filter(({ id, status }) => status === "retired" && byPlace.has(id))
    .toSorted((a, b) => movedAt(b.id) - movedAt(a.id));
  return [...open, ...closed];
}
