import type { SpecialistUpdateCardWire } from "@auni/shared";

import { formatGlanceableUsd } from "@/lib/money";

type Change = SpecialistUpdateCardWire["changes"][number];

/** "150.00" reads "$150"; cents stay when there are any. */
function wholeUsd(value: string): string {
  const dollars = Number(value);
  return Number.isFinite(dollars) ? formatGlanceableUsd(dollars) : value;
}

/** One change in plain words: "Now acts on its own", "Renamed to Nuclear". */
function phrase({ field, before, after }: Change): string {
  switch (field) {
    case "purpose":
      return `Now “${after}”`;
    case "name":
      return `Renamed to ${after}`;
    case "potUsd":
      return `${wholeUsd(before)} → ${wholeUsd(after)} behind it`;
    case "actMode":
      return after === "within_limits" ? "Now acts on its own" : "Now asks first";
  }
}

/**
 * The one line a chat edit leaves: a lead naming the change that matters
 * most ("Now acts on its own", "Renamed to Nuclear") and the rest in plain words.
 */
export function describeSpecialistUpdate(changes: readonly Change[]): {
  readonly lead: string;
  readonly details: readonly string[];
} {
  const lead =
    changes.find((change) => change.field === "actMode") ??
    changes.find((change) => change.field === "name");
  if (lead) {
    return {
      lead: phrase(lead),
      details: changes.filter((change) => change !== lead).map(phrase),
    };
  }
  return {
    lead: changes.some((change) => change.field === "purpose") ? "Reworded" : "Money updated",
    details: changes.map(phrase),
  };
}
