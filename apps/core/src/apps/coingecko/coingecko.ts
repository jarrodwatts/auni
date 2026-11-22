import { NETWORKS } from "@auni/shared";

import type { ListedToken } from "../contract.ts";

import { chainIdOf } from "../../money/chains.ts";
import { cached, fetchJson, lastGood } from "../../money/swaps/shared.ts";

// CoinGecko, with no key: its token list for each EVM network, which is what Auni recognises a
// token there by, and a token's artwork, which covers newer tokens other lists carry bare.

/** Each list read so far, by platform (see listed). */
const lists = new Map<string, () => Promise<ReadonlyMap<string, ListedToken>>>();

/**
 * The tokens on its list for an EVM network, by lowercased address; empty for a network
 * it lists none for. Reread daily, as it adds tokens through the day and a list a day old
 * misses only the newest; the last list it served answers while a reread fails (see
 * lastGood), so it throws only while the list has never been read.
 */
export function listed(chain: string): Promise<ReadonlyMap<string, ListedToken>> {
  const platform = Object.hasOwn(NETWORKS, chain)
    ? NETWORKS[chain as keyof typeof NETWORKS].coingecko
    : null;
  if (!platform) return Promise.resolve(new Map());
  let list = lists.get(platform);
  if (!list) {
    list = lastGood(() => loadList(platform), {
      rereadMs: 24 * 60 * 60_000,
      retryMs: 60_000,
      failed: (error) => console.warn(`CoinGecko's ${platform} token list unavailable:`, error),
    });
    lists.set(platform, list);
  }
  return list();
}

async function loadList(platform: string): Promise<ReadonlyMap<string, ListedToken>> {
  const body = await fetchJson<{ tokens: { address: string; symbol: string; name: string }[] }>(
    `https://tokens.coingecko.com/${platform}/all.json`,
    { timeoutMs: 20_000 },
  );
  return new Map(
    body.tokens.map(({ address, symbol, name }) => [address.toLowerCase(), { symbol, name }]),
  );
}

/** Its name for each chain it lists, by chain id. */
const platforms = cached(24 * 60 * 60_000, async () => {
  const all = await fetchJson<{ id: string; chain_identifier: number | null }[]>(
    "https://api.coingecko.com/api/v3/asset_platforms",
  );
  return new Map(all.map(({ id, chain_identifier }) => [chain_identifier, id]));
});

/** Its artwork for a token on an EVM chain; null when it has none, or can't say. */
export async function logo(chain: string, token: string): Promise<string | null> {
  let chainId: number;
  try {
    chainId = chainIdOf(chain);
  } catch {
    return null;
  }
  const platform = (await platforms("all").catch(() => null))?.get(chainId);
  if (!platform) return null;
  const coin = await fetchJson<{ image?: { large?: string } }>(
    `https://api.coingecko.com/api/v3/coins/${platform}/contract/${token.toLowerCase()}`,
    { timeoutMs: 5_000 },
  ).catch(() => null);
  return coin?.image?.large ?? null;
}
