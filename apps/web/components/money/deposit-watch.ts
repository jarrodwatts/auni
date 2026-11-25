import type { DepositWire } from "@auni/shared";

import type { FundingNeed } from "@/lib/app-links";
import { dollarsToBaseUnits } from "@/lib/data/usdc";

/**
 * What landed, all together, in USDC base units. USDC counts by its own amount, to the last unit,
 * as a dollar of it is a dollar: its dollars are cut to the cent, so 24.995 and 25.005 USDC would
 * add up a cent short of 50. Any other coin counts by its dollars when it arrived.
 */
export function landedTotal(landed: readonly DepositWire[]): bigint {
  return landed.reduce(
    (total, { amount, cash, usdValue }) => total + dollarsToBaseUnits(cash ? amount : usdValue),
    0n,
  );
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
