import { isAddress } from "viem";

import type { TokenListing } from "../contract.ts";
import { chainIdOf } from "../../money/chains.ts";
import type { TokenPrice } from "../../money/history.ts";
import { cached, fetchJson, HttpError } from "../../money/swaps/shared.ts";

// LI.FI's token list: what a token on an EVM chain is, its price and its picture, with no key.
// It lists and prices tokens the price feed asked before it doesn't, such as most xStocks on
// Monad, and any token on a chain that feed doesn't name.

interface Listed {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly priceUSD?: string;
  readonly logoURI?: string;
}

/** Its listing for a token, keyed `chainId:token` (an address or a symbol), each kept ten minutes; null for one it doesn't list. */
const listed = cached(10 * 60_000, async (key) => {
  const [chainId, token] = key.split(":");
  return fetchJson<Listed>(`https://li.quest/v1/token?chain=${chainId}&token=${token}`, {
    timeoutMs: 5_000,
  }).catch((error: unknown) => {
    // LI.FI answers 400 for a token it doesn't list: an answer, kept like any other.
    if (error instanceof HttpError && error.status === 400) return null;
    throw error;
  });
});

/** Its key for a token on one of core's chains; null for a chain that isn't an EVM one. */
function keyOf(chain: string, token: string): string | null {
  try {
    return `${chainIdOf(chain)}:${token}`;
  } catch {
    return null;
  }
}

export async function listing(chain: string, token: string): Promise<TokenListing | null> {
  const key = keyOf(chain, token);
  const found = key ? await listed(key) : null;
  if (!found) return null;
  const { address, symbol, name, decimals, priceUSD } = found;
  const usdPrice = priceUSD && Number(priceUSD) > 0 ? Number(priceUSD) : null;
  return { address, symbol, name, decimals, usdPrice };
}

export async function logo(chain: string, token: string): Promise<string | null> {
  const key = keyOf(chain, token);
  return (key ? await listed(key) : null)?.logoURI ?? null;
}

/**
 * The price now of each id that names an EVM token ("monad:0x…", "eip155:N:0x…"): it keeps
 * no past price, and prices nothing it can't find by chain and address.
 */
export async function prices(
  ids: readonly string[],
  at?: Date,
): Promise<ReadonlyMap<string, TokenPrice>> {
  const priced = new Map<string, TokenPrice>();
  if (at) return priced;
  await Promise.all(
    ids.map(async (id) => {
      const split = id.lastIndexOf(":");
      const address = id.slice(split + 1);
      if (!isAddress(address)) return;
      const price = (await listing(id.slice(0, split), address))?.usdPrice;
      if (price) priced.set(id, { price });
    }),
  );
  return priced;
}
