import { readFileSync, writeFileSync } from "node:fs";

import { EVM_CHAIN_KEYS, NETWORKS } from "@auni/shared";
import { createPublicClient, fallback, http, type PublicClient } from "viem";

import type * as Chains from "../money/chains.ts";

// Real answers to the reads of one real wallet, recorded once from public RPCs and services and
// played back, so a test runs the real readers on what that wallet really held. A test file
// mocks with it:
//
//   vi.mock("./chains.ts", async (o) => (await import("../test/recorded.ts")).chains(await o(), FILE));
//
// With RECORD=1 every read goes to the chain's first public RPC (or the service) and the
// answers are written to FILE when the file's tests end (save); otherwise each read is answered
// from FILE, and one it holds no answer for throws, naming it. Only a chain's head is frozen
// while recording, so every read made "now" is made at one block.

const RECORDING = process.env.RECORD === "1";

/** The real fetch, taken before a test stands one in, for what records. */
const realFetch = globalThis.fetch;

/** One read and its answer: a balance, a call's result, or that it failed. */
interface Answer {
  readonly ok: boolean;
  readonly result?: unknown;
}

export interface Recording {
  /** By chain id, method and arguments (see keyOf). */
  rpc: Record<string, Answer>;
  /** By method, URL and body. */
  http: Record<string, { status: number; body: string }>;
  /** Anything else a test keeps beside them: prices, lists. */
  kept: Record<string, unknown>;
}

const recordings = new Map<string, Recording>();

function recording(file: string): Recording {
  let found = recordings.get(file);
  if (!found) {
    found = RECORDING
      ? { rpc: {}, http: {}, kept: {} }
      : (JSON.parse(readFileSync(file, "utf8"), revive) as Recording);
    recordings.set(file, found);
  }
  return found;
}

/** Bigints kept as {"$big": "..."}, as JSON holds none. */
function replace(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { $big: value.toString() } : value;
}
function revive(_key: string, value: unknown): unknown {
  return value && typeof value === "object" && "$big" in value
    ? BigInt((value as { $big: string }).$big)
    : value;
}

const keyOf = (...parts: unknown[]) =>
  JSON.stringify(parts, replace).toLowerCase().replaceAll('"', "");

const realClients = new Map<number, PublicClient>();
function realClient(chainId: number): PublicClient {
  let client = realClients.get(chainId);
  if (!client) {
    const network = EVM_CHAIN_KEYS.map((key) => NETWORKS[key]).find(
      (one) => one.viem.id === chainId,
    )!;
    client = createPublicClient({
      chain: network.viem,
      transport: fallback(
        network.rpcs.map((url) =>
          http(url, { retryCount: 3, timeout: 30_000, fetchFn: realFetch }),
        ),
      ),
    }) as PublicClient;
    realClients.set(chainId, client);
  }
  return client;
}

interface Call {
  readonly address: string;
  readonly functionName: string;
  readonly args?: readonly unknown[];
  readonly abi: unknown;
}

/** A client answering getBlockNumber, getBalance, getCode, readContract and multicall from `file`. */
function client(file: string, chainId: number): PublicClient {
  const kept = recording(file);
  const heads = kept.kept.heads as Record<string, bigint> | undefined;
  const answer = async (key: string, read: () => Promise<unknown>): Promise<Answer> => {
    const found = kept.rpc[key];
    if (found) return found;
    if (!RECORDING) throw new Error(`No recorded answer for ${key}`);
    try {
      kept.rpc[key] = { ok: true, result: await read() };
    } catch {
      kept.rpc[key] = { ok: false };
    }
    return kept.rpc[key];
  };
  const value = (found: Answer, what: string) => {
    if (!found.ok) throw new Error(`recorded as failing: ${what}`);
    return found.result;
  };
  const one = async (call: Call, blockNumber?: bigint) => {
    const key = keyOf(chainId, call.address, call.functionName, call.args ?? [], blockNumber);
    return answer(key, () => realClient(chainId).readContract({ ...call, blockNumber } as never));
  };
  const network = EVM_CHAIN_KEYS.map((key) => NETWORKS[key]).find(
    (each) => each.viem.id === chainId,
  )!;
  return {
    chain: network.viem,
    async getBlockNumber() {
      kept.kept.heads ??= {};
      const all = kept.kept.heads as Record<string, bigint>;
      if (RECORDING) all[chainId] ??= await realClient(chainId).getBlockNumber();
      const head = (heads ?? all)[chainId];
      if (head === undefined) throw new Error(`No recorded head for chain ${chainId}`);
      return head;
    },
    async getBalance({ address, blockNumber }: { address: string; blockNumber?: bigint }) {
      const key = keyOf(chainId, "balance", address, blockNumber);
      return value(
        await answer(key, () => realClient(chainId).getBalance({ address, blockNumber } as never)),
        key,
      );
    },
    async getCode({ address }: { address: string }) {
      const key = keyOf(chainId, "code", address);
      return value(await answer(key, () => realClient(chainId).getCode({ address } as never)), key);
    },
    async readContract(call: Call & { blockNumber?: bigint }) {
      return value(await one(call, call.blockNumber), `${call.functionName} on ${call.address}`);
    },
    async multicall({
      contracts,
      allowFailure = true,
      blockNumber,
    }: {
      contracts: readonly Call[];
      allowFailure?: boolean;
      blockNumber?: bigint;
    }) {
      if (RECORDING) {
        // Asked as the reader asks, in one multicall, then kept a call at a time.
        const read = await realClient(chainId).multicall({
          contracts: contracts as never,
          allowFailure: true,
          blockNumber,
          batchSize: 50_000,
        } as never);
        (read as { status: string; result?: unknown }[]).forEach((each, index) => {
          const call = contracts[index]!;
          kept.rpc[keyOf(chainId, call.address, call.functionName, call.args ?? [], blockNumber)] =
            each.status === "success" ? { ok: true, result: each.result } : { ok: false };
        });
      }
      const answers = await Promise.all(contracts.map((call) => one(call, blockNumber)));
      if (!allowFailure)
        return answers.map((found, index) => value(found, contracts[index]!.functionName));
      return answers.map((found) =>
        found.ok
          ? { status: "success", result: found.result }
          : { status: "failure", error: new Error("recorded as failing") },
      );
    },
  } as unknown as PublicClient;
}

/** money/chains.ts, with every EVM client answering from `file`. */
export function chains(original: unknown, file: string): typeof Chains {
  const clients = new Map<number, PublicClient>();
  const evmClient = (chainId: number) => {
    let found = clients.get(chainId);
    if (!found) clients.set(chainId, (found = client(file, chainId)));
    return found;
  };
  return {
    ...(original as typeof Chains),
    evmClient,
    publicClient: (key) => evmClient(NETWORKS[key].viem.id),
  };
}

/**
 * A fetch answering from `file` by method, URL and body, as recorded from the services at
 * `hosts`. While recording, a request to any other host goes out unrecorded (a price feed a
 * test keeps its own way, see kept); played back, it throws.
 */
export function recordedFetch(file: string, hosts: readonly string[]): typeof fetch {
  const kept = recording(file);
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = `${init?.method ?? "GET"} ${url} ${typeof init?.body === "string" ? init.body : ""}`;
    const recorded = hosts.includes(new URL(url).hostname);
    if (RECORDING && !recorded) return realFetch(input, init);
    if (RECORDING && !kept.http[key]) {
      const response = await realFetch(input, init);
      kept.http[key] = { status: response.status, body: await response.text() };
    }
    const found = kept.http[key];
    if (!found) throw new Error(`No recorded answer for ${key}`);
    return new Response(found.body, { status: found.status });
  };
}

/**
 * Something a test keeps beside the reads (a price, a list): `read` is asked while recording,
 * and its answer is played back otherwise.
 */
export async function kept<T>(file: string, name: string, read: () => Promise<T>): Promise<T> {
  const found = recording(file);
  if (RECORDING && !(name in found.kept)) found.kept[name] = await read();
  if (!(name in found.kept)) throw new Error(`Nothing recorded as ${name}`);
  return found.kept[name] as T;
}

/** Whether this run records (RECORD=1). */
export const recordingNow = RECORDING;

/**
 * Writes what this run recorded to `file`, as `cut` leaves it: a test keeps what it needs of a
 * list of thousands of tokens the wallet holds none of, not each one's balance.
 */
export function save(file: string, cut: (recorded: Recording) => Recording = (all) => all) {
  if (RECORDING) writeFileSync(file, `${JSON.stringify(cut(recording(file)), replace, 1)}\n`);
}
