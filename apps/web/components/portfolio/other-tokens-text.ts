import type { OtherTokensWire } from "@auni/shared";

import { formatUsd } from "@/lib/money";

/** The one row other tokens get among their holdings: "Other tokens (3)". */
export function otherTokensLabel(count: number): string {
  return `Other tokens (${count.toLocaleString("en-US")})`;
}

/**
 * What they hold of one and where, and what a price feed says it's worth, which its
 * sender may have set: "1,000 on Base, worth $40", "5 on Base, no price".
 */
export function otherTokenLine(
  token: Pick<OtherTokensWire["tokens"][number], "amount" | "usdValue">,
  network: string,
): string {
  if (token.amount === null) return `On ${network}. Balance unavailable`;
  const amount = Number(token.amount).toLocaleString("en-US", { maximumSignificantDigits: 6 });
  const held = `${amount} on ${network}`;
  return token.usdValue === null
    ? `${held}, no price`
    : `${held}, worth ${formatUsd(token.usdValue)}`;
}
