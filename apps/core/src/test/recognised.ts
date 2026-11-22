import { fillIdentity } from "../money/fill-key.ts";
import { registryName, type Listing } from "../money/recognised.ts";

/**
 * The lists Auni recognises tokens by, stood in for: the registry's coins and
 * cash as the code knows them, and any other token only as `listed` names it,
 * by fillIdentity ("base:0xabc…") to its symbol. Nothing is fetched.
 */
export function listingsOf(listed: Readonly<Record<string, string>>) {
  return async (chain: string, instruments: readonly string[]): Promise<Map<string, Listing>> =>
    new Map(
      instruments.map((instrument) => {
        const key = fillIdentity({ chain, instrument });
        const registry = registryName(chain, instrument);
        const symbol = registry ?? listed[key] ?? null;
        // A listed token here is named by its symbol, as a list that gives no more would.
        return [key, { recognised: symbol !== null, symbol, name: registry ? null : symbol }];
      }),
    );
}
