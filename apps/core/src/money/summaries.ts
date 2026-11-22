import type { ActionRow } from "../db/schema.ts";
import type { Money } from "./recipe.ts";
import { centsToUsd, signedUsdToCents, sumUsd, usdToCents } from "./usd.ts";

type ActionFacts = Pick<ActionRow, "status" | "phase" | "summary" | "amountUsd">;

/** "$150" for whole dollars, "$150.50" otherwise. */
export function dollars(usd: string): string {
  const cents = usdToCents(usd);
  const whole = (cents / 100n).toLocaleString("en-US");
  return cents % 100n === 0n
    ? `$${whole}`
    : `$${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** A big amount as people say it: "$1.2M", "$530K". */
export function roughDollars(usd: number): string {
  return `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(usd)}`;
}

/** Signed change between two dollar amounts, either of which may be below zero, e.g. "-3.20". */
export function differenceUsd(current: string, baseline: string): string {
  return centsToUsd(signedUsdToCents(current) - signedUsdToCents(baseline));
}

/**
 * What some moves do with money, in a phrase: "$50 in", "about $82 back",
 * "$25 in, about $41 back". What comes back is a quote, so it's "about". Cash
 * only moved between their own places has no one honest total (savings out,
 * then bridged, is one sum moved twice), so it isn't said. Null when they move
 * none of the rest.
 */
export function moneyLine(moneys: readonly (Money | null)[]): string | null {
  const total = (flow: Money["flow"]) =>
    sumUsd(moneys.flatMap((money) => (money?.flow === flow ? [money.usd] : [])));
  const [going, back] = [total("in"), total("back")];
  const parts = [
    usdToCents(going) > 0n ? `${dollars(going)} in` : null,
    usdToCents(back) > 0n ? `about ${dollars(back)} back` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** What a waiting card asks, in one line: the move itself, or its moves counted with their money. */
export function askLine(
  legs: readonly { readonly summary: string; readonly money: Money | null }[],
): string | null {
  const [first] = legs;
  if (!first) return null;
  if (legs.length === 1) return first.summary;
  const money = moneyLine(legs.map((leg) => leg.money));
  return `${legs.length} moves${money ? `, ${money}` : ""}`;
}

/** One line of a specialist's record of what Auni did. */
export function activityLabel(action: ActionFacts): string {
  switch (action.status) {
    case "awaiting_permission":
      return `Asked you: ${action.summary}`;
    case "running":
      return action.phase === "needs_owner"
        ? `Not confirmed, waiting on you: ${action.summary}`
        : `Working on: ${action.summary}`;
    case "done":
      return action.summary;
    case "failed":
      return `Didn't go through: ${action.summary}`;
    case "cancelled":
      return `You declined: ${action.summary}`;
    case "replaced":
      return `Replaced by a newer plan: ${action.summary}`;
    case "retracted":
      return `Taken back: ${action.summary}`;
  }
}
