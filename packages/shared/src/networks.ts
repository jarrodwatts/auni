import type { Chain } from "viem";
import {
  arbitrum,
  base,
  bsc,
  ink,
  mainnet,
  monad,
  polygon,
  robinhood,
  unichain,
} from "viem/chains";

import { BNB, ETHEREUM, MONAD, POLYGON, SOLANA, type KnownAsset } from "./known-assets.ts";

/**
 * The networks Auni moves money on, one entry each. Every list of them in core
 * and web is read from here or typed against it, so no screen can offer a
 * chain core can't handle. A network joins only once it's been checked live
 * end to end, as people can then send any token in on it: the Portal offers its
 * address and promises "any token" there, so core's sweep must
 * record and price what lands, the network's own coin included.
 */
interface Network {
  /**
   * Auni's own name for it, the one stored and sent on the wire: "monad". It is
   * DefiLlama's name for the chain too, so a token here is priced as `<key>:<address>`.
   */
  readonly key: string;
  /** As people read it: "Base". */
  readonly name: string;
  /** viem's chain, which carries the chain id; null for Solana, the one that isn't EVM. */
  readonly viem: Chain | null;
  /** Where a person sees its transactions, for the one viem doesn't describe; an EVM chain's is viem's. */
  readonly explorer?: { readonly name: string; readonly url: string };
  /**
   * Native USDC: its contract, or on Solana its mint; null where Circle issues
   * none, so whatever dollar lands there is a token like any other. Every cash
   * network has one. On Monad, 0x534b... is the testnet token; never use it here.
   */
  readonly usdc: string | null;
  /**
   * Tether's USDT as Tether or USDT0 (its omnichain USDT) lists it: its
   * contract, or on Solana its mint; null where neither issues one. Named on a
   * card like USDC, but not cash (see isPlainCash): it is a token held.
   */
  readonly usdt: string | null;
  /** The network's own coin, which pays its gas, and DefiLlama's id for its price. */
  readonly coin: {
    readonly asset: KnownAsset;
    readonly decimals: number;
    readonly priceId: string;
    /**
     * The coin's own face as a token: a contract whose balanceOf is the coin's balance, which
     * token lists list. It is the coin, never a second holding of it. Polygon's alone, of
     * Auni's chains (probed November 2026: every token each feed lists, asked of a wallet
     * holding the coin).
     */
    readonly token?: string;
  };
  /**
   * CoinGecko's platform id for its token list (tokens.coingecko.com/<id>/all.json),
   * which says which tokens here Auni recognises; null on Solana, where Jupiter does.
   */
  readonly coingecko: string | null;
  /**
   * Public RPCs that serve what Auni needs of it, asked in turn when the owner set neither an RPC
   * of their own (RPC_URL_<KEY>) nor an Alchemy key: a later one answers what an earlier one
   * refuses. A wallet's deposits are found with eth_getLogs over thousands of blocks and its past
   * balances (money/sweep.ts), and a card's effect with eth_simulateV1, which not every chain's
   * own RPC serves (probed November 2026).
   */
  readonly rpcs: readonly [string, ...string[]];
  /** Alchemy's RPC subdomain for it, used when ALCHEMY_API_KEY is set. */
  readonly alchemy: string;
  /** The network's mark. */
  readonly logo: string;
  /**
   * Auni spends USDC here as Cash: a card's funding draws on it, and savings
   * and withdrawals use it. Anywhere else, what arrives is a holding, priced,
   * until a card pays with it and Across carries it home in one move (see
   * conversionLegs), so each network that joins adds deposits, not a place
   * every card's funding must weigh.
   */
  readonly cash: boolean;
}

const LIST = [
  {
    key: "monad",
    name: "Monad",
    viem: monad,
    usdc: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    usdt: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
    coin: { asset: MONAD, decimals: 18, priceId: "coingecko:monad" },
    coingecko: "monad",
    rpcs: ["https://rpc2.monad.xyz", "https://rpc.monad.xyz"],
    alchemy: "monad-mainnet",
    logo: "/brand/chains/monad.svg",
    cash: true,
  },
  {
    key: "base",
    name: "Base",
    viem: base,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    // The USDT on Base is bridged from Ethereum by Base's own bridge, not issued by Tether.
    usdt: null,
    coin: { asset: ETHEREUM, decimals: 18, priceId: "coingecko:ethereum" },
    coingecko: "base",
    rpcs: ["https://mainnet.base.org", "https://base.gateway.tenderly.co"],
    alchemy: "base-mainnet",
    logo: "/brand/chains/base.svg",
    cash: true,
  },
  {
    key: "arbitrum",
    name: "Arbitrum",
    viem: arbitrum,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    coin: { asset: ETHEREUM, decimals: 18, priceId: "coingecko:ethereum" },
    coingecko: "arbitrum-one",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.gateway.tenderly.co"],
    alchemy: "arb-mainnet",
    logo: "/brand/chains/arbitrum.svg",
    cash: true,
  },
  {
    key: "polygon",
    name: "Polygon",
    viem: polygon,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    usdt: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    coin: {
      asset: POLYGON,
      decimals: 18,
      priceId: "coingecko:polygon-ecosystem-token",
      token: "0x0000000000000000000000000000000000001010",
    },
    coingecko: "polygon-pos",
    rpcs: ["https://polygon.drpc.org", "https://polygon.gateway.tenderly.co"],
    alchemy: "polygon-mainnet",
    logo: "/brand/tokens/pol.png",
    cash: true,
  },
  {
    key: "ethereum",
    name: "Ethereum",
    viem: mainnet,
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    coin: { asset: ETHEREUM, decimals: 18, priceId: "coingecko:ethereum" },
    coingecko: "ethereum",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://mainnet.gateway.tenderly.co"],
    alchemy: "eth-mainnet",
    logo: "/brand/chains/ethereum.svg",
    cash: false,
  },
  {
    key: "unichain",
    name: "Unichain",
    viem: unichain,
    usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    usdt: "0x9151434b16b9763660705744891fA906F660EcC5",
    coin: { asset: ETHEREUM, decimals: 18, priceId: "coingecko:ethereum" },
    coingecko: "unichain",
    rpcs: ["https://mainnet.unichain.org", "https://unichain.gateway.tenderly.co"],
    alchemy: "unichain-mainnet",
    logo: "/brand/chains/unichain.svg",
    cash: false,
  },
  {
    key: "ink",
    name: "Ink",
    viem: ink,
    usdc: "0x2D270e6886d130D724215A266106e6832161EAEd",
    usdt: "0x0200C29006150606B650577BBE7B6248F58470c1",
    coin: { asset: ETHEREUM, decimals: 18, priceId: "coingecko:ethereum" },
    coingecko: "ink",
    rpcs: ["https://rpc-gel.inkonchain.com", "https://ink.gateway.tenderly.co"],
    alchemy: "ink-mainnet",
    logo: "/brand/chains/ink.svg",
    cash: false,
  },
  {
    key: "robinhood",
    name: "Robinhood Chain",
    viem: robinhood,
    // Its dollar is USDG, the Global Dollar; neither Circle nor Tether issues one here.
    usdc: null,
    usdt: null,
    coin: { asset: ETHEREUM, decimals: 18, priceId: "coingecko:ethereum" },
    coingecko: "robinhood",
    rpcs: ["https://rpc.mainnet.chain.robinhood.com"],
    alchemy: "robinhood-mainnet",
    logo: "/brand/chains/robinhood.png",
    cash: false,
  },
  {
    key: "bnb",
    name: "BNB Chain",
    viem: bsc,
    // Its USDC and USDT are Binance's pegged tokens (18 decimals), not Circle's or Tether's.
    usdc: null,
    usdt: null,
    coin: { asset: BNB, decimals: 18, priceId: "coingecko:binancecoin" },
    coingecko: "binance-smart-chain",
    // thirdweb's public RPC refused every call ("Rate limit exceeded", November 2026), and BNB
    // Chain's own and publicnode's list no logs without a token's address: these two do, 5,000
    // blocks a call, and the third answers reads and simulations when both are busy.
    rpcs: [
      "https://public-bsc.nownodes.io",
      "https://rpc-bsc.48.club",
      "https://bsc-dataseed.bnbchain.org",
    ],
    alchemy: "bnb-mainnet",
    logo: "/brand/chains/bnb.svg",
    cash: false,
  },
  {
    key: "solana",
    name: "Solana",
    viem: null,
    explorer: { name: "Solscan", url: "https://solscan.io" },
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    coin: { asset: SOLANA, decimals: 9, priceId: "coingecko:solana" },
    coingecko: null,
    rpcs: ["https://api.mainnet-beta.solana.com"],
    alchemy: "solana-mainnet",
    logo: "/brand/chains/solana.svg",
    cash: true,
  },
] as const satisfies readonly Network[];

type Entry = (typeof LIST)[number];
export type NetworkKey = Entry["key"];
export type EvmChainKey = Extract<Entry, { readonly viem: Chain }>["key"];

/** Each network by its key. */
export const NETWORKS = Object.fromEntries(LIST.map((network) => [network.key, network])) as {
  readonly [Key in NetworkKey]: Extract<Entry, { readonly key: Key }>;
};

/** Every network, in the order screens list them. */
export const NETWORK_KEYS: readonly NetworkKey[] = LIST.map((network) => network.key);

export function isEvmChain(key: NetworkKey): key is EvmChainKey {
  return NETWORKS[key].viem !== null;
}

export const EVM_CHAIN_KEYS: readonly EvmChainKey[] = NETWORK_KEYS.filter(isEvmChain);

/** A network where Auni spends USDC as Cash (see Network.cash). */
export type CashKey = Extract<Entry, { readonly cash: true }>["key"];
export type EvmCashKey = CashKey & EvmChainKey;

export function isCash(key: string): key is CashKey {
  return Object.hasOwn(NETWORKS, key) && NETWORKS[key as NetworkKey].cash;
}

/** The coin's own token face on `key`, lowercased (see Network.coin.token); null where it has none. */
export function coinToken(key: string): string | null {
  if (!Object.hasOwn(NETWORKS, key)) return null;
  const { coin }: Network = NETWORKS[key as NetworkKey];
  return coin.token?.toLowerCase() ?? null;
}

/** The networks where Auni spends USDC as Cash, in NETWORK_KEYS' order. */
export const CASH_KEYS: readonly CashKey[] = NETWORK_KEYS.filter(isCash);
export const EVM_CASH_KEYS: readonly EvmCashKey[] = EVM_CHAIN_KEYS.filter(
  (key): key is EvmCashKey => isCash(key),
);

/** Solana mainnet as CAIP-2 names it: by its genesis hash. */
export const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
