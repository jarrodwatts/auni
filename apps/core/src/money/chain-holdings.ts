import { NETWORKS, type EvmCashKey, type NetworkKey } from "@auni/shared";
import { erc20Abi, parseAbi, zeroAddress, type Address } from "viem";

import type { RawHolding, AccountHolding } from "../apps/contract.ts";
import { sortTokens, tokenName, type Sorted } from "./buckets.ts";
import {
  chainKey,
  evmChainById,
  evmClient,
  publicClient,
  solanaRpc,
  SPL_TOKEN_PROGRAMS,
} from "./chains.ts";
import { evmTokenKey, fillIdentity, solanaMintKey } from "./fill-key.ts";
import { evmXStocks } from "./swaps/xstocks.ts";

// What the owner's own wallets hold, read from each chain.

/** A network's own coin as a holding reads it. */
function nativeCoin(network: NetworkKey) {
  const { asset, decimals, priceId } = NETWORKS[network].coin;
  return { symbol: asset.symbol, decimals, priceId };
}

/**
 * On an EVM chain an xStock's balance is its shares times a multiplier that
 * its stock's dividends and splits grow (STRCx's was 1.097 in October 2026),
 * while a price feed prices one share, as Solana holds it. So it is valued by
 * its shares; priced by its balance it would read that much too high.
 * docs.xstocks.fi/developers/multipliers
 */
const XSTOCK_SHARES = parseAbi(["function sharesOf(address) view returns (uint256)"]);

/**
 * A wallet on an EVM chain: its coin, its USDC where it has one, the tokens
 * Auni bought there, and those that only `arrived` (see readTokens), each
 * named by its bucket as `sorted` has it (see tokenName).
 */
export async function readEvmWallet(
  chainId: number,
  owner: Address,
  tokens: readonly Address[],
  arrived: readonly Address[] = [],
  sorted: ReadonlyMap<string, Sorted> = new Map(),
): Promise<RawHolding[]> {
  const client = evmClient(chainId);
  const known = evmChainById(chainId);
  const key = chainKey(chainId);
  const usdc = known?.usdc ?? null;
  const listed = new Set([...(usdc ? [usdc] : []), ...tokens].map((token) => token.toLowerCase()));
  const [native, usdcRead, bought, received] = await Promise.all([
    client.getBalance({ address: owner }),
    // USDC is known, so only its balance is read.
    usdc
      ? client
          .readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
          .then((balance): TokenRead[] => [{ token: usdc, balance, decimals: 6, symbol: "USDC" }])
      : [],
    readTokens(
      client,
      owner,
      tokens.filter((token) => token.toLowerCase() !== usdc?.toLowerCase()),
      { strict: true },
    ),
    readTokens(
      client,
      owner,
      arrived.filter((token) => !listed.has(token.toLowerCase())),
      { strict: false },
    ),
  ]);
  const coin = known
    ? nativeCoin(known.key)
    : {
        symbol: client.chain?.nativeCurrency.symbol ?? "?",
        decimals: client.chain?.nativeCurrency.decimals ?? 18,
        // The price id of the coin of a chain Auni has no name for (see Tokens).
        priceId: `${key}:${zeroAddress}`,
      };
  return [
    {
      venue: "wallet",
      ...evmTokenKey(key, "native"),
      symbol: coin.symbol,
      baseUnits: native,
      decimals: coin.decimals,
      priceId: coin.priceId,
      cash: false,
    },
    ...[...usdcRead, ...bought, ...received].map(
      ({ token, balance, pricedUnits, decimals, symbol }): RawHolding => {
        // Cash, at a dollar, only where Auni spends it (see Network.cash); priced like any token elsewhere.
        const cash = token === usdc && known?.cash === true;
        const named = tokenName(
          evmTokenKey(key, token),
          sorted.get(fillIdentity(evmTokenKey(key, token))),
          symbol,
        );
        return {
          venue: "wallet",
          ...evmTokenKey(key, token),
          symbol: cash ? "USDC" : named,
          baseUnits: balance,
          ...(pricedUnits === undefined ? {} : { pricedUnits }),
          decimals,
          priceId: cash ? null : `${key}:${token}`,
          cash,
        };
      },
    ),
  ];
}

/**
 * Without the catalog a held xStock can't be told apart, and priced by its balance it would
 * read too high, so the chain counts as unread. Every one is named `<ticker>x`.
 */
const UNKNOWN_STOCK = "xStock catalog unavailable to value a held xStock";

export interface TokenRead {
  readonly token: Address;
  readonly balance: bigint;
  /** What an xStock's price counts, its shares (see XSTOCK_SHARES); absent for any other token. */
  readonly pricedUnits?: bigint;
  readonly decimals: number;
  /** Its maker's word (see tokenName). */
  readonly symbol: string;
}

/**
 * ERC-20 tokens' balances, decimals and symbols in one multicall, as of
 * `blockNumber` if given, with an xStock's shares as of the same. `strict`
 * is for tokens Auni bought: any read that fails throws, so the chain counts
 * as unread. Otherwise, for tokens that only arrived, which anyone can send,
 * one whose balance or decimals won't answer is left out, so a token built to
 * fail can't leave the chain unread, and a symbol that won't is "".
 */
export async function readTokens(
  client: ReturnType<typeof evmClient>,
  owner: Address,
  tokens: readonly Address[],
  { strict, blockNumber }: { readonly strict: boolean; readonly blockNumber?: bigint },
): Promise<TokenRead[]> {
  if (tokens.length === 0) return [];
  const [reads, stocks] = await Promise.all([
    client.multicall({
      blockNumber,
      contracts: tokens.flatMap((token) => [
        { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] } as const,
        { address: token, abi: erc20Abi, functionName: "decimals" } as const,
        { address: token, abi: erc20Abi, functionName: "symbol" } as const,
      ]),
      allowFailure: true,
    }),
    // Null while no catalog has loaded.
    evmXStocks().catch(() => null),
  ]);
  if (strict) {
    const failed = reads.find((read) => read.status !== "success");
    if (failed) throw failed.error;
  }
  const read = tokens.flatMap((token, index) => {
    const [balance, decimals, symbol] = reads.slice(index * 3, index * 3 + 3);
    if (balance?.status !== "success" || decimals?.status !== "success") return [];
    return [
      {
        token,
        balance: BigInt(balance.result as bigint),
        decimals: Number(decimals.result),
        symbol: symbol?.status === "success" ? String(symbol.result) : "",
      },
    ];
  });
  if (!stocks && read.some(({ balance, symbol }) => balance > 0n && symbol.endsWith("x")))
    throw new Error(UNKNOWN_STOCK);
  return Promise.all(
    read.map(async (one) =>
      stocks?.has(one.token.toLowerCase())
        ? {
            ...one,
            pricedUnits: await client.readContract({
              address: one.token,
              abi: XSTOCK_SHARES,
              functionName: "sharesOf",
              args: [owner],
              blockNumber,
            }),
          }
        : one,
    ),
  );
}

/**
 * What a Solana wallet holds of each mint, across its token accounts, and
 * the slot each was read at. Each token program is read apart, and which
 * one a mint it holds none of is under isn't known, so that one stands at
 * `slot`, the earlier read.
 */
export async function solanaTokens(owner: string): Promise<{
  slot: number;
  byMint: Map<string, { amount: bigint; decimals: number; slot: number }>;
}> {
  const programAccounts = await Promise.all(
    SPL_TOKEN_PROGRAMS.map((programId) =>
      solanaRpc<{
        context: { slot: number };
        value: {
          account: {
            data: {
              parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } };
            };
          };
        }[];
      }>("getTokenAccountsByOwner", [
        owner,
        { programId },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]),
    ),
  );
  const byMint = new Map<string, { amount: bigint; decimals: number; slot: number }>();
  for (const { context, value } of programAccounts) {
    for (const { account } of value) {
      const { mint, tokenAmount } = account.data.parsed.info;
      const current = byMint.get(mint);
      byMint.set(mint, {
        amount: (current?.amount ?? 0n) + BigInt(tokenAmount.amount),
        decimals: tokenAmount.decimals,
        slot: context.slot,
      });
    }
  }
  return { slot: Math.min(...programAccounts.map(({ context }) => context.slot)), byMint };
}

/**
 * Each of these tokens' buckets, to name them by (see tokenName): what is
 * read is what Auni's records count, so a list that can't be read now only
 * leaves a name to its own symbol or its address, never the chain unread.
 */
export function namesOf(
  chain: string,
  instruments: readonly string[],
): Promise<Map<string, Sorted>> {
  return sortTokens(chain, instruments, "unlisted");
}

/**
 * A Solana wallet: its SOL, wrapped or not, its USDC, and each of `mints` it
 * holds, those Auni's records count (see readPortfolio), named by its
 * bucket. Any other token account is left unread, as anyone can send a mint.
 */
export async function readSolanaWallet(
  owner: string,
  mints: ReadonlySet<string>,
): Promise<RawHolding[]> {
  const [lamports, { byMint: accounts }] = await Promise.all([
    solanaRpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]),
    solanaTokens(owner),
  ]);
  const byMint = [...accounts].filter(([mint]) => {
    const { instrument } = solanaMintKey(mint);
    return mint === NETWORKS.solana.usdc || instrument === "native" || mints.has(instrument);
  });
  const sorted = await namesOf(
    "solana",
    byMint.map(([mint]) => solanaMintKey(mint).instrument),
  );
  return [
    {
      venue: "wallet",
      chain: "solana",
      instrument: "native",
      ...nativeCoin("solana"),
      baseUnits: BigInt(lamports.value),
      cash: false,
    },
    // Tokenized stocks are ordinary mints here. Value is raw units at the
    // per-token price; the issuer's share multiplier only changes the share
    // count shown, never the dollars.
    ...byMint.map(([mint, { amount, decimals }]): RawHolding => ({
      venue: "wallet",
      ...solanaMintKey(mint),
      symbol: tokenName(solanaMintKey(mint), sorted.get(fillIdentity(solanaMintKey(mint)))),
      baseUnits: amount,
      decimals,
      priceId: mint === NETWORKS.solana.usdc ? null : `solana:${mint}`,
      cash: mint === NETWORKS.solana.usdc,
    })),
  ];
}

/**
 * Savings on one chain, held as an account's savings `token` and counted as cash at a dollar:
 * each of its whole units one USDC (see AccountCash), in the token's own decimals.
 */
export async function readSavings(
  chain: EvmCashKey,
  token: Address,
  owner: Address,
): Promise<AccountHolding[]> {
  const [baseUnits, decimals] = await publicClient(chain).multicall({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: token, abi: erc20Abi, functionName: "decimals" },
    ],
    allowFailure: false,
  });
  return [
    {
      ...evmTokenKey(chain, token),
      symbol: "USDC",
      baseUnits,
      decimals,
      priceId: null,
      cash: true,
    },
  ];
}
