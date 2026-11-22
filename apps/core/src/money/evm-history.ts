import type { EvmChainKey } from "@auni/shared";
import { pad, toHex, type Address, type Hex, type PublicClient } from "viem";

import { eachRpc, keepsNoStateAt, publicClient, rpcAnswered } from "./chains.ts";
import { TRANSFER_TOPIC } from "./transfers.ts";

/**
 * What an EVM chain says moved through a wallet over a range of blocks, read with the plain RPC
 * methods any node serves (eth_getLogs, past eth_getBalance), so no indexer is needed: a token's
 * moves from its Transfer logs, and the chain's own coin, which logs nothing, from where its
 * balance rose.
 */

/** One ERC-20 Transfer with the wallet on one side. */
export interface TransferLog {
  readonly hash: string;
  readonly block: number;
  /** The token's contract, lowercase. */
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly units: bigint;
}

/** Most blocks one eth_getLogs call asks for, and fewest: an RPC that refuses more is asked half. */
const MOST_BLOCKS = 10_000;
const FEWEST_BLOCKS = 100;

/** Calls in a row an RPC answers at its span before it is asked for twice the span again. */
const GROW_AFTER = 10;

/**
 * The span each RPC takes, by its URL, learned as it refuses wider ones, and the calls it has
 * answered since. Each endpoint has its own limit, and a chain's endpoints differ widely (probed
 * November 2026): Polygon's first public RPC refuses over 100 blocks a call while its second
 * takes 10,000 but often gives no answer within 15 seconds, and Base's first refuses logs while
 * busy at any span. A refusal can also be passing, so the span grows back as calls are answered.
 */
const spans = new Map<string, { readonly span: number; readonly answered: number }>();

/** Which of a chain's RPCs last answered for its logs: asked first next time. */
const answering = new Map<EvmChainKey, string>();

/** A chain's RPCs, the one that last answered its logs first. */
function logRpcs(chain: EvmChainKey) {
  const rpcs = eachRpc(chain);
  const first = rpcs.findIndex(({ url }) => url === answering.get(chain));
  return first > 0 ? [...rpcs.slice(first), ...rpcs.slice(0, first)] : rpcs;
}

/** How many blocks one eth_getLogs call on this chain asks for, of the RPC asked first. */
export function logSpan(chain: EvmChainKey): number {
  return spanOf(logRpcs(chain)[0]!.url);
}

function spanOf(url: string): number {
  return spans.get(url)?.span ?? MOST_BLOCKS;
}

function answeredAt(url: string): void {
  const learned = spans.get(url);
  if (!learned) return;
  spans.set(
    url,
    learned.answered + 1 < GROW_AFTER
      ? { span: learned.span, answered: learned.answered + 1 }
      : { span: Math.min(MOST_BLOCKS, learned.span * 2), answered: 0 },
  );
}

/**
 * How far each of a chain's RPCs has itself got, asked of it once and again only for a block
 * past what it said. An RPC behind the chain's head answers an empty list for blocks it doesn't
 * have yet (four of the public ones did, probed 2026-11-14), which reads as nothing having moved
 * in them: so its logs are asked for, and counted, only up to its own head. Kept for one read,
 * not longer: behind one address there may be several nodes, not all as far along.
 */
function headsAsked() {
  const heads = new Map<string, number>();
  return async (
    { url, client }: { readonly url: string; readonly client: PublicClient },
    block: number,
  ): Promise<number> => {
    const known = heads.get(url);
    if (known !== undefined && known >= block) return known;
    const head = Number(await client.request({ method: "eth_blockNumber" }));
    heads.set(url, head);
    return head;
  };
}

interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: Hex;
  readonly transactionHash: string;
}

/**
 * Every ERC-20 Transfer into the wallet (`side` "in") or out of it in blocks [from, `through`],
 * of one token or any, oldest first, a span at a time. `through` is `to` unless no RPC has
 * reached that far yet: the blocks after it are for the next read, never passed as empty. Each
 * of the chain's RPCs is asked at its own span (see spans), and only up to its own head (see
 * headsAsked): one that refuses a span is asked half, and one that gives no answer, refuses even
 * FEWEST_BLOCKS or hasn't reached the span passes it to the next; when none answers, this throws.
 * One of no value, the usual address poisoning, isn't listed. ERC-721's Transfer shares the
 * topic but indexes its token id too, so it isn't read as one.
 */
export async function transferLogs(
  chain: EvmChainKey,
  wallet: string,
  side: "in" | "out",
  from: number,
  to: number,
  token?: string,
): Promise<{ readonly logs: TransferLog[]; readonly through: number }> {
  const walletTopic = pad(wallet.toLowerCase() as Hex);
  const topics =
    side === "in" ? [TRANSFER_TOPIC, null, walletTopic] : [TRANSFER_TOPIC, walletTopic];
  const found: TransferLog[] = [];
  const rpcs = logRpcs(chain);
  const reached = headsAsked();
  let at = 0;
  // The RPCs that couldn't serve the span now being read, after the one asked first, and why
  // the last of them that failed did.
  let passed = 0;
  let failure: unknown;
  let start = from;
  while (start <= to) {
    const rpc = rpcs[at]!;
    const span = spanOf(rpc.url);
    const wanted = Math.min(to, start + span - 1);
    // The last block asked of it; before `start` until it says how far it has got.
    let end = start - 1;
    let logs: readonly RawLog[] | undefined;
    try {
      end = Math.min(wanted, await reached(rpc, wanted));
      if (end >= start)
        logs = (await rpc.client.request({
          method: "eth_getLogs",
          params: [
            {
              fromBlock: toHex(start),
              toBlock: toHex(end),
              topics,
              ...(token ? { address: token } : {}),
            },
          ],
        } as never)) as readonly RawLog[];
    } catch (error) {
      // Public RPCs cap a call's range or its answer's size, each with its own error code and
      // words, so any refusal of its logs is read as "too wide".
      if (end >= start && rpcAnswered(error) && span > FEWEST_BLOCKS) {
        spans.set(rpc.url, { span: Math.max(FEWEST_BLOCKS, Math.floor(span / 2)), answered: 0 });
        continue;
      }
      failure = error;
    }
    if (!logs) {
      passed += 1;
      if (passed < rpcs.length) {
        at = (at + 1) % rpcs.length;
        continue;
      }
      if (failure !== undefined) throw failure;
      // Every RPC is behind this block: it is read once one has reached it.
      break;
    }
    answeredAt(rpc.url);
    answering.set(chain, rpc.url);
    passed = 0;
    failure = undefined;
    for (const log of logs) {
      const [, sender, receiver] = log.topics;
      if (!sender || !receiver || log.topics.length !== 3 || log.data.length !== 66) continue;
      const units = BigInt(log.data);
      if (units === 0n) continue;
      found.push({
        hash: log.transactionHash.toLowerCase(),
        block: Number(log.blockNumber),
        token: log.address.toLowerCase(),
        from: `0x${sender.slice(-40)}`,
        to: `0x${receiver.slice(-40)}`,
        units,
      });
    }
    start = end + 1;
  }
  return { logs: found, through: start - 1 };
}

/** Chains whose RPC keeps no past balances, said once each while Auni runs. */
const noPastBalances = new Set<EvmChainKey>();

/**
 * Transactions that sent the chain's own coin straight to the wallet in blocks [from, to]. No log
 * names them, so the balance is read at both ends and, where it rose, halved down to each block
 * it rose in (about 2·log₂ of the span in reads a block), whose transactions to the wallet
 * carrying coin are the deposits. Two kinds show only in the balance a reading takes: coin a
 * contract sends (a bridge's delivery has no transaction of its own to the wallet), and a deposit
 * in a span where the wallet spent more of the coin than came in, which nets out. Stops after
 * `most` blocks it rose in, `through` the last of them; where the RPC says it keeps no state for
 * those blocks, finds none. Any other failure, a busy RPC's among them, throws, so the blocks
 * are searched again rather than passed.
 */
export async function coinDeposits(
  chain: EvmChainKey,
  wallet: string,
  from: number,
  to: number,
  most: number,
): Promise<{ txs: { hash: string; block: number }[]; through: number }> {
  const client = publicClient(chain);
  const balance = (block: number) =>
    client.getBalance({ address: wallet as Address, blockNumber: BigInt(block) });
  const rose: number[] = [];
  let through = to;
  // Each block in (low, high] the balance rose in, given it at both ends; false once `most` are found.
  const search = async (
    low: number,
    atLow: bigint,
    high: number,
    atHigh: bigint,
  ): Promise<boolean> => {
    if (atHigh <= atLow) return true;
    if (high - low === 1) {
      rose.push(high);
      if (rose.length < most) return true;
      through = high;
      return false;
    }
    const middle = Math.floor((low + high) / 2);
    const atMiddle = await balance(middle);
    return (await search(low, atLow, middle, atMiddle)) && search(middle, atMiddle, high, atHigh);
  };
  const before = Math.max(from - 1, 0);
  try {
    const [atBefore, atEnd] = await Promise.all([balance(before), balance(to)]);
    await search(before, atBefore, to, atEnd);
  } catch (error) {
    if (!keepsNoStateAt(error)) throw error;
    if (!noPastBalances.has(chain)) {
      noPastBalances.add(chain);
      console.warn(
        `${chain}'s RPC keeps no past balances, so coin sent in shows only in readings.`,
      );
    }
    return { txs: [], through: to };
  }
  const blocks = await Promise.all(
    rose.map((block) => client.getBlock({ blockNumber: BigInt(block), includeTransactions: true })),
  );
  const own = wallet.toLowerCase();
  return {
    txs: blocks.flatMap((block) =>
      block.transactions.flatMap((tx) =>
        tx.to?.toLowerCase() === own && tx.value > 0n
          ? [{ hash: tx.hash.toLowerCase(), block: Number(block.number) }]
          : [],
      ),
    ),
    through,
  };
}
