import { chainIdOf } from "../../money/chains.ts";
import { fetchJson } from "../../money/swaps/shared.ts";

/** DexScreener's name for each EVM chain it lists, by chain id. */
const CHAINS: Readonly<Record<number, string>> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
  137: "polygon",
  143: "monad",
  4663: "robinhood",
};

/** The artwork a token's own listing on DexScreener carries, which covers tokens no venue lists. */
export async function logo(chain: string, address: string): Promise<string | null> {
  const dexChain = chain === "solana" ? chain : CHAINS[chainIdOf(chain)];
  if (!dexChain) return null;
  const pairs = await fetchJson<{ baseToken: { address: string }; info?: { imageUrl?: string } }[]>(
    `https://api.dexscreener.com/tokens/v1/${dexChain}/${encodeURIComponent(address)}`,
    { timeoutMs: 5_000 },
  );
  // Pairs list the token on either side; only its own side's artwork is its own.
  return (
    pairs.find(
      (pair) =>
        pair.baseToken.address.toLowerCase() === address.toLowerCase() && pair.info?.imageUrl,
    )?.info?.imageUrl ?? null
  );
}
