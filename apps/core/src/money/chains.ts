import { setTimeout as sleep } from "node:timers/promises";

import {
  EVM_CHAIN_KEYS,
  appListing,
  NETWORKS,
  type EvmChainKey,
  type NetworkKey,
} from "@auni/shared";
import { address, createSolanaRpc, type Address as SolanaAddress } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import {
  createPublicClient,
  fallback,
  http,
  isAddressEqual,
  RpcError,
  RpcRequestError,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import * as viemChains from "viem/chains";

import { env } from "../env.ts";
import { WRAPPED_SOL } from "./fill-key.ts";
import type { CashPlace } from "./recipe.ts";

/**
 * Coin the owner's wallet can never spend on a chain. Auni's Monad wallet is
 * delegated (EIP-7702) for sponsored gas, and Monad reverts any move that
 * takes a delegated wallet's MON below 10.
 */
export const RESERVES: Readonly<Partial<Record<EvmChainKey, bigint>>> = {
  monad: 10n * 10n ** 18n,
};

/** The classic SPL token program and Token-2022: every Solana token account belongs to one. */
export const SPL_TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

/** Native USDC on Solana, a classic SPL token. */
export const SOLANA_USDC = {
  mint: address(NETWORKS.solana.usdc),
  decimals: 6,
  tokenProgram: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
} as const;

const EVM_NETWORKS = EVM_CHAIN_KEYS.map((key) => NETWORKS[key]);

/** One of Auni's EVM networks by its chain id; undefined for any other chain. */
export function evmChainById(chainId: number) {
  return EVM_NETWORKS.find((network) => network.viem.id === chainId);
}

/** Whether a token is native USDC on one of Auni's EVM networks that has it. */
export function isUsdcAt(chainId: number, token: string): boolean {
  const usdc = evmChainById(chainId)?.usdc;
  return !!usdc && isAddressEqual(token as Address, usdc);
}

/** A chain Auni names, or any chain id, bare or as eip155:N. */
export function chainIdOf(chain: string): number {
  const known = EVM_NETWORKS.find((network) => network.key === chain);
  if (known) return known.viem.id;
  const id = Number(chain.replace(/^eip155:/, ""));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Unknown chain: ${chain}.`);
  return id;
}

/** How a sent transaction's chain is recorded: Auni's key, or its CAIP-2 id. */
export function chainKey(chainId: number): EvmChainKey | `eip155:${number}` {
  return evmChainById(chainId)?.key ?? `eip155:${chainId}`;
}

export function chainName(chain: NetworkKey): string {
  return NETWORKS[chain].name;
}

/** Where cash sits, as a person reads it: a network ("Base"), or a venue's account, by its name. */
export function placeName(place: CashPlace): string {
  return Object.hasOwn(NETWORKS, place)
    ? chainName(place as NetworkKey)
    : (appListing(place)?.name ?? place);
}

/** viem's entry for another EVM chain recorded as eip155:N, which names it and its coin. */
export function viemChain(chain: string): Chain | undefined {
  const id = Number(/^eip155:(\d+)$/u.exec(chain)?.[1]);
  return (Object.values(viemChains) as Chain[]).find((each) => each.id === id);
}

/** Any holding's chain as a person reads it: "Base", "Solana", or viem's name for another EVM chain ("OP Mainnet"). */
export function chainLabel(chain: string): string {
  if (chain in NETWORKS) return chainName(chain as NetworkKey);
  return viemChain(chain)?.name ?? chain;
}

/**
 * Where a person can see a transaction on its chain: the explorer's name ("Monadscan") and the
 * page; null for a chain Auni knows no explorer for (an exchange's own ledger).
 */
export function explorerTx(
  chain: string,
  hash: string,
): { readonly name: string; readonly url: string } | null {
  const network = Object.hasOwn(NETWORKS, chain) ? NETWORKS[chain as NetworkKey] : null;
  const explorer =
    network && "explorer" in network
      ? network.explorer
      : (network?.viem ?? viemChain(chain))?.blockExplorers?.default;
  return explorer ? { name: explorer.name, url: `${explorer.url}/tx/${hash}` } : null;
}

/** Alchemy's RPC subdomain for each EVM chain it serves Auni: Auni's own, and others the agent builds on. */
export const ALCHEMY_NETWORKS: Readonly<Record<number, string>> = {
  ...Object.fromEntries(EVM_NETWORKS.map((network) => [network.viem.id, network.alchemy])),
  10: "opt-mainnet",
};

interface Endpoint {
  readonly url: string;
  readonly headers?: { readonly authorization: string };
}

/**
 * Where Auni reaches a chain, as one or more RPCs asked in turn:
 *
 *   own      RPC_URL_<CHAIN>, alone, so a fork or node of the owner's own sees every read and send
 *   alchemy  with ALCHEMY_API_KEY, on a chain Alchemy serves
 *   public   the chain's public RPCs (NETWORKS' `rpcs`), or viem's for another EVM chain
 */
interface Rpc {
  readonly source: "own" | "alchemy" | "public";
  readonly endpoints: readonly [Endpoint, ...Endpoint[]];
}

/** Alchemy's RPC for a network, its key in a header: an RPC error repeats the URL it asked, and errors are logged. */
function alchemy(network: string | undefined): Rpc | null {
  return env.ALCHEMY_API_KEY && network
    ? {
        source: "alchemy",
        endpoints: [
          {
            url: `https://${network}.g.alchemy.com/v2`,
            headers: { authorization: `Bearer ${env.ALCHEMY_API_KEY}` },
          },
        ],
      }
    : null;
}

function publicRpc(urls: readonly [string, ...string[]]): Rpc {
  return {
    source: "public",
    endpoints: [{ url: urls[0] }, ...urls.slice(1).map((url) => ({ url }))],
  };
}

/** How Auni reaches one of its networks, or another EVM chain by id (see Rpc). */
export function rpcFor(chain: NetworkKey | number): Rpc {
  const key = typeof chain === "number" ? evmChainById(chain)?.key : chain;
  const own = key && env.RPC_URLS[key];
  if (own) return { source: "own", endpoints: [{ url: own }] };
  if (key) return alchemy(NETWORKS[key].alchemy) ?? publicRpc(NETWORKS[key].rpcs);
  const id = chain as number;
  return alchemy(ALCHEMY_NETWORKS[id]) ?? publicRpc([readableChain(id).rpcUrls.default.http[0]!]);
}

/**
 * Whether an RPC answered that it keeps no state at the block asked about: a node that prunes it
 * ("missing trie node", "historical state … is not available") or one that serves it only to
 * paying callers ("Archive requests require a personal token"), as the default RPCs said when
 * probed (November 2026). Matched by its words, as each node gives its own code, and a busy RPC's
 * codes (-32005, -32011, 35, …) mean only that asking later may work.
 */
export function keepsNoStateAt(error: unknown): boolean {
  const answer = rpcAnswer(error);
  return (
    answer !== null &&
    /missing trie node|historical state|state[^.]*(?:not available|unavailable)|pruned|archive/iu.test(
      answer.details,
    )
  );
}

/**
 * The error an RPC answered with, by any code, known to viem or not, wherever viem wrapped it: a
 * balance read at a past block goes through a multicall, whose error carries the RPC's as its
 * cause, so Robinhood Chain's "historical state … is not available" was read as no answer, and
 * the arrivals sweep there failed on every pass.
 */
function rpcAnswer(error: unknown): RpcError | RpcRequestError | null {
  for (let at = error; at instanceof Error; at = at.cause)
    if (at instanceof RpcError || at instanceof RpcRequestError) return at;
  return null;
}

/** Whether an RPC answered with an error of its own (see rpcAnswer). */
export function rpcAnswered(error: unknown): boolean {
  return rpcAnswer(error) !== null;
}

const clients = new Map<number, PublicClient>();
const publicClients = new Map<number, PublicClient>();

/** viem's entry for a chain Auni can read: no testnet, and a public RPC that isn't local. */
function readableChain(chainId: number): Chain {
  const chain = (Object.values(viemChains) as Chain[]).find(
    ({ id, testnet, rpcUrls }) =>
      id === chainId &&
      !testnet &&
      /^https:\/\/(?!localhost|127\.)/u.test(rpcUrls.default.http[0] ?? ""),
  );
  if (!chain) throw new Error(`Unknown chain: ${chainId}.`);
  return chain;
}

/**
 * A client that asks each of `endpoints` in turn, until one answers. Where the Rpc has another
 * endpoint to ask (`several`), a busy one is passed at once: viem waits out a 429's Retry-After,
 * which a rate-limited public RPC can set to minutes.
 */
function clientOf(
  chainId: number,
  endpoints: readonly [Endpoint, ...Endpoint[]],
  several = endpoints.length > 1,
): PublicClient {
  const transports = endpoints.map(({ url, headers }) =>
    http(url, {
      retryCount: several ? 0 : 2,
      timeout: 15_000,
      ...(headers ? { fetchOptions: { headers } } : {}),
    }),
  );
  return createPublicClient({
    chain: readableChain(chainId),
    // A reverted call is an answer, which viem's fallback never asks the next endpoint about.
    transport: transports.length > 1 ? fallback(transports, { retryCount: 0 }) : transports[0]!,
    batch: { multicall: true },
  }) as PublicClient;
}

/** One cached client per chain id (see rpcFor). Testnets, and chains whose RPC is missing or local, are unknown. */
export function evmClient(chainId: number): PublicClient {
  let client = clients.get(chainId);
  if (!client) {
    client = clientOf(chainId, rpcFor(chainId).endpoints);
    clients.set(chainId, client);
  }
  return client;
}

/**
 * The chain's public RPCs, for a simulation Alchemy couldn't run; null where
 * evmClient doesn't read through Alchemy, as an RPC of the owner's own is used alone.
 */
export function publicRpcClient(chainId: number): PublicClient | null {
  if (rpcFor(chainId).source !== "alchemy") return null;
  let client = publicClients.get(chainId);
  if (!client) {
    const network = evmChainById(chainId);
    client = clientOf(
      chainId,
      publicRpc(network ? network.rpcs : [readableChain(chainId).rpcUrls.default.http[0]!])
        .endpoints,
    );
    publicClients.set(chainId, client);
  }
  return client;
}

export function publicClient(key: EvmChainKey): PublicClient {
  return evmClient(NETWORKS[key].viem.id);
}

const endpointClients = new Map<string, PublicClient>();

/**
 * Each of a network's RPCs on its own (see rpcFor), by its URL, for a read whose limits differ
 * from one endpoint to the next: how many blocks of logs one serves a call (see transferLogs).
 */
export function eachRpc(
  key: EvmChainKey,
): { readonly url: string; readonly client: PublicClient }[] {
  const { endpoints } = rpcFor(key);
  return endpoints.map((endpoint) => {
    let client = endpointClients.get(endpoint.url);
    if (!client) {
      client = clientOf(NETWORKS[key].viem.id, [endpoint], endpoints.length > 1);
      endpointClients.set(endpoint.url, client);
    }
    return { url: endpoint.url, client };
  });
}

/** Solana's RPC as @solana/kit's typed client; solanaRpc below takes any method by name. */
export function solanaKitRpc() {
  const [{ url, headers }] = rpcFor("solana").endpoints;
  return createSolanaRpc(url, headers ? { headers } : {});
}

/** The node answered a Solana RPC call with an error, as opposed to giving no answer at all. */
export class SolanaRpcRefused extends Error {}

/**
 * One Solana RPC call by name. `onPublic` asks Solana's own public RPC instead,
 * for a simulation Alchemy couldn't run; elsewhere it asks the same RPC again.
 */
export async function solanaRpc<T>(
  method: string,
  params: unknown[],
  { onPublic }: { readonly onPublic?: true } = {},
): Promise<T> {
  const rpc = rpcFor("solana");
  const [{ url, headers }] = (
    onPublic && rpc.source === "alchemy" ? publicRpc(NETWORKS.solana.rpcs) : rpc
  ).endpoints;
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method} returned ${response.status}.`);
  const body = (await response.json()) as { result?: T; error?: { message?: string } };
  if (body.error)
    throw new SolanaRpcRefused(
      `Solana RPC ${method} failed: ${body.error.message ?? "no reason"}.`,
    );
  if (body.result === undefined) throw new Error(`Solana RPC ${method} failed: no result.`);
  return body.result;
}

/** Waits until a sent Solana transaction is confirmed, or throws when it failed or never was. */
export async function waitForSolanaSignature(signature: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { value } = await solanaRpc<{
      value: ({ err: unknown; confirmationStatus: string | null } | null)[];
    }>("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
    const status = value[0];
    if (status?.err) throw new Error(`The Solana transaction failed (${signature}).`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return;
    }
    await sleep(1_500);
  }
  throw new Error(`The Solana transaction was not confirmed within 90 seconds (${signature}).`);
}

/** The wallet's raw balance of a token (0 when it has no account yet); SOL is its native lamports, as swaps leave it. */
export async function solanaTokenBalance(
  owner: SolanaAddress,
  mint: SolanaAddress,
  tokenProgram: SolanaAddress,
): Promise<bigint> {
  if (mint === WRAPPED_SOL) {
    const { value } = await solanaKitRpc().getBalance(owner, { commitment: "confirmed" }).send();
    return BigInt(value);
  }
  const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  try {
    const { value } = await solanaKitRpc().getTokenAccountBalance(account).send();
    return BigInt(value.amount);
  } catch (error) {
    if (String(error).includes("could not find account")) return 0n;
    throw error;
  }
}
