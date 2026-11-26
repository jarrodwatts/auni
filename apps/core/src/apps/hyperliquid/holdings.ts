import type { Address } from "viem";

import { QUANTITY_DECIMALS } from "../../money/fill-key.ts";
import { centsToUsd, parseUnits, signedUsdToCents } from "../../money/usd.ts";
import type { AccountHolding } from "../contract.ts";
import { readAccount, splitAccount } from "./account.ts";
import { coinKey } from "./keys.ts";

const cents = (micros: bigint) => micros / 10_000n;

/**
 * The account as splitAccount splits it: free USDC is Cash, USDC that orders
 * hold is cash held for them, and each position is worth what closing it
 * would free, so the holdings add up to the account's value, short only of
 * the part of a cent each rounds down.
 */
export async function readHyperliquid(owner: Address): Promise<AccountHolding[]> {
  const { free, onOrders, positions } = splitAccount(await readAccount(owner));
  const usdc = (micros: bigint) => ({
    chain: "hyperliquid",
    instrument: "USDC",
    symbol: "USDC",
    baseUnits: cents(micros) * 10n ** 4n,
    decimals: 6,
    priceId: null,
    cash: true,
  });
  return [
    usdc(free),
    { ...usdc(onOrders), heldForOrders: true },
    ...positions.map(({ position, micros }): AccountHolding => ({
      ...coinKey(position.coin),
      symbol: position.coin,
      baseUnits: parseUnits(position.szi.replace("-", ""), QUANTITY_DECIMALS),
      decimals: QUANTITY_DECIMALS,
      priceId: null,
      usdValue: centsToUsd(cents(micros)),
      cash: false,
      short: position.szi.startsWith("-"),
      leverage: position.leverage.value,
      ...(position.entryPx ? { averageCostUsd: position.entryPx } : {}),
      unrealizedPnlUsd: centsToUsd(signedUsdToCents(position.unrealizedPnl)),
    })),
  ];
}
