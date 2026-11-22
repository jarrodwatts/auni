import { ETHEREUM, isCash, MONAD, NETWORKS, POLYGON, type KnownAsset } from "@auni/shared";

import { viemChain } from "./chains.ts";
import { fillIdentity } from "./fill-key.ts";

/** Wrapped and bridged forms of the chains' own coins: to a person they are the coin itself. */
const FORMS = new Map<string, KnownAsset>(
  (
    [
      ["base", "0x4200000000000000000000000000000000000006", ETHEREUM],
      ["arbitrum", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", ETHEREUM],
      ["polygon", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", ETHEREUM],
      ["monad", "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242", ETHEREUM],
      ["solana", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", ETHEREUM],
      ["monad", "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", MONAD],
      ["polygon", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", POLYGON],
    ] as const
  ).map(([chain, instrument, coin]) => [fillIdentity({ chain, instrument }), coin]),
);

/** The coins Auni's networks run on: Ether, Monad, Polygon, BNB and Solana. */
const COINS = Object.values(NETWORKS).map((network) => network.coin.asset);

/**
 * The chain coin a holding or a trade's token is, wrapped or not. Known by
 * its address, never its symbol, which any token can copy; null for anything
 * else.
 */
export function coinOf(key: {
  readonly chain: string;
  readonly instrument: string;
}): KnownAsset | null {
  if (key.instrument === "native") return nativeCoin(key.chain);
  return FORMS.get(fillIdentity(key)) ?? null;
}

/**
 * Whether a token is its chain's own coin wrapped as a token (WMON on Monad,
 * WETH on Base): the same coin, held beside the coin itself, so it is named
 * apart from it ("Wrapped Monad"). A coin bridged from another chain (WETH on
 * Monad) is the only form of it there, so it is named as the coin.
 */
export function isWrappedCoin(key: {
  readonly chain: string;
  readonly instrument: string;
}): boolean {
  if (key.instrument === "native") return false;
  const coin = coinOf(key);
  return coin !== null && coin === nativeCoin(key.chain);
}

/**
 * A chain's own coin: the registry's for Auni's networks, and for another EVM
 * chain the one of their coins viem names as its currency, so Ether held on
 * OP Mainnet is Ether as it is on Base. The chain says what its coin is, not a
 * token, so the symbol can be trusted here.
 */
function nativeCoin(chain: string): KnownAsset | null {
  if (Object.hasOwn(NETWORKS, chain)) return NETWORKS[chain as keyof typeof NETWORKS].coin.asset;
  const symbol = viemChain(chain)?.nativeCurrency.symbol;
  return COINS.find((coin) => coin.symbol === symbol) ?? null;
}

/**
 * The network's USDC where Auni spends it: plain cash, which a deposit or
 * withdrawal moves alone, so neither makes anything (see madeUsd). Elsewhere
 * USDC is a token like any other, priced, its deposits money put in.
 */
export function isPlainCash(chain: string, instrument: string): boolean {
  if (!isCash(chain)) return false;
  const { usdc } = NETWORKS[chain];
  return fillIdentity({ chain, instrument }) === fillIdentity({ chain, instrument: usdc });
}

/**
 * What moved, by name when it is the network's own coin, its USDC or its
 * USDT; null for any other token, which is named by its address, never the
 * name it gives itself.
 */
export function coinName(key: {
  readonly chain: string;
  readonly instrument: string;
}): string | null {
  if (key.instrument === "native") return coinOf(key)?.symbol ?? null;
  if (!Object.hasOwn(NETWORKS, key.chain)) return null;
  const { usdc, usdt } = NETWORKS[key.chain as keyof typeof NETWORKS];
  const at = (address: string) =>
    fillIdentity(key) === fillIdentity({ chain: key.chain, instrument: address });
  if (usdc !== null && at(usdc)) return "USDC";
  if (usdt !== null && at(usdt)) return "USDT";
  return null;
}
