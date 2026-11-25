import type { DepositWire } from "@auni/shared";

import type { FundingNeed } from "@/lib/app-links";
import { dollarsToBaseUnits } from "@/lib/data/usdc";

/** What landed, all together, in USDC base units. */
export function landedTotal(landed: readonly DepositWire[]): bigint {
  return landed.reduce((total, { usdValue }) => total + dollarsToBaseUnits(usdValue), 0n);
}

/**
 * What a card short of `need` still waits for once these landed, in base units: only USDC on the
 * network it's short on counts, since any other coin, or USDC elsewhere, is no cash it can spend
 * there. Zero once it's covered, or when nothing was asked.
 */
export function stillNeeded(need: FundingNeed | null, landed: readonly DepositWire[]): bigint {
  if (!need) return 0n;
  const left =
    dollarsToBaseUnits(need.usd) - landedTotal(landed.filter(({ cash }) => cash === need.chain));
  return left > 0n ? left : 0n;
}
