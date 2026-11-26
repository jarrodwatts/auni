import type { Money } from "./recipe.ts";
import { centsToUsd, signedUsdToCents, sumUsd, usdToCents } from "./usd.ts";

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
 * What some moves do with money, in a phrase, as their card says it under its amount: "$50 to
 * put in", "about $82 back", "$25 to put in, about $41 back". What comes back is a quote, so it's
 * "about", unless every card it comes from promises at least that, as a sell that may fill in
 * part does: then it is a floor on the card's own condition ("at least $191.68 back if all 310
 * sell"), never a bare one. Floors on conditions of their own add up to no one honest figure,
 * so what they bring back isn't said. Cash only moved between their own places has no one
 * honest total either (savings out, then bridged, is one sum moved twice). Null when they move
 * none of the rest. Needs you, the sidebar, Telegram's cards and the agent all say a card's
 * money with this, so none reads it another way.
 */
export function moneyLine(moneys: readonly (Money | null)[]): string | null {
  const flowing = (flow: Money["flow"]) =>
    moneys.flatMap((money) => (money?.flow === flow ? [money] : []));
  const total = (some: readonly Money[]) => sumUsd(some.map(({ usd }) => usd));
  const [going, back] = [flowing("in"), flowing("back")];
  const parts = [
    usdToCents(total(going)) > 0n ? `${dollars(total(going))} to put in` : null,
    usdToCents(total(back)) > 0n ? backLine(back, dollars(total(back))) : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** What comes back, `amount` in all: a quote, or a floor with its condition; null when neither is honest. */
function backLine(back: readonly Money[], amount: string): string | null {
  if (!back.every((money) => money.least !== undefined)) return `about ${amount} back`;
  const conditions = new Set(back.map((money) => money.least));
  if (conditions.size > 1 || (back.length > 1 && !conditions.has(""))) return null;
  const [condition] = conditions;
  return `at least ${amount} back${condition ? ` ${condition}` : ""}`;
}

/**
 * What a waiting card asks, in one line: its move in the card's own short words with the money
 * beside it ("Sell Yes, about $201 back"; "Buy $250" already says it), or its moves counted with
 * their money.
 */
export function askLine(
  legs: readonly { readonly says: string; readonly money: Money | null }[],
): string | null {
  const [first] = legs;
  if (!first) return null;
  const money = moneyLine(legs.map((leg) => leg.money));
  if (legs.length > 1) return `${legs.length} moves${money ? `, ${money}` : ""}`;
  return money && !first.says.includes("$") ? `${first.says}, ${money}` : first.says;
}
