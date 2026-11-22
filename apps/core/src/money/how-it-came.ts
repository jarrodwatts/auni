import type { EvmChainKey, NetworkKey } from "@auni/shared";
import { erc20Abi, type Address } from "viem";

import { publicClient, solanaRpc } from "./chains.ts";
import { logSpan, transferLogs, type TransferLog } from "./evm-history.ts";
import { shortAddress } from "./format.ts";
import { readTransfers } from "./transfers.ts";
import { addressBook } from "./readers.ts";
import { formatUnits } from "./usd.ts";

/**
 * How a token came to be in a wallet: the latest times it moved in or out,
 * read from the chain when Auni begins counting one it held quietly (see
 * tellRecognised in news.ts), so Auni can say where it came from rather than
 * guess. Read once, never kept.
 */

/** How many moves a story tells, newest first: enough to say where a balance came from. */
export const MOVES = 12;

/** One time the token moved into or out of the wallet. */
export interface Move {
  readonly at: Date;
  /** Whole units, negative when it left. */
  readonly amount: string;
  /** The other side, by what a venue knows it as to the owner ("their deposit wallet"), or its address. */
  readonly who: string | null;
}

/**
 * The latest moves of a token into or out of `wallet` on `chain`, newest
 * first. Throws while the chain can't be read.
 */
export function howItCame(chain: NetworkKey, wallet: string, token: string): Promise<Move[]> {
  return chain === "solana"
    ? solanaMoves(wallet, token)
    : evmMoves(chain, wallet as Address, token as Address);
}

/** What the apps call addresses on `chain` to the owner, all in one map. */
async function addressNames(chain: EvmChainKey, owner: Address): Promise<Map<string, string>> {
  return new Map((await addressBook(chain, owner)).flatMap(({ names }) => [...names]));
}

/** Spans of logs (see logSpan) a story reads back at most, each way: past them it isn't told. */
const SPANS_BACK = 25;

/**
 * The token's Transfer logs each way, read back from the head a span at a
 * time until MOVES are found or SPANS_BACK spans are read; newest first.
 */
async function evmMoves(chain: EvmChainKey, wallet: Address, token: Address): Promise<Move[]> {
  const client = publicClient(chain);
  const names = await addressNames(chain, wallet);
  const name = (address: string): string =>
    names.get(address.toLowerCase()) ?? shortAddress(address);
  const found: { log: TransferLog; cameIn: boolean }[] = [];
  let to = Number(await client.getBlockNumber());
  for (let spans = 0; spans < SPANS_BACK && to >= 0 && found.length < MOVES; spans += 1) {
    const from = Math.max(to - logSpan(chain) + 1, 0);
    const [into, out] = await Promise.all([
      transferLogs(chain, wallet, "in", from, to, token),
      transferLogs(chain, wallet, "out", from, to, token),
    ]);
    found.push(
      ...into.logs.map((log) => ({ log, cameIn: true })),
      ...out.logs.map((log) => ({ log, cameIn: false })),
    );
    to = from - 1;
  }
  const latest = found.toSorted((a, b) => b.log.block - a.log.block).slice(0, MOVES);
  if (latest.length === 0) return [];
  const blocks = [...new Set(latest.map(({ log }) => log.block))];
  const [decimals, ...stamped] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ...blocks.map((block) => client.getBlock({ blockNumber: BigInt(block) })),
  ]);
  const at = new Map(
    stamped.map((block) => [Number(block.number), new Date(Number(block.timestamp) * 1_000)]),
  );
  return latest.map(({ log, cameIn }) => ({
    at: at.get(log.block)!,
    amount: formatUnits(cameIn ? log.units : -log.units, Number(decimals)),
    who: name(cameIn ? log.from : log.to),
  }));
}

/** The latest transactions of the wallet's accounts of `mint`, each read for what it moved of it. */
async function solanaMoves(wallet: string, mint: string): Promise<Move[]> {
  const { value: accounts } = await solanaRpc<{ value: { pubkey: string }[] }>(
    "getTokenAccountsByOwner",
    [wallet, { mint }, { encoding: "jsonParsed" }],
  );
  const listed = await Promise.all(
    accounts.map(({ pubkey }) =>
      solanaRpc<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [
        pubkey,
        { limit: MOVES, commitment: "confirmed" },
      ]),
    ),
  );
  // One transaction can touch two of its accounts, and reads as the wallet's whole change once.
  const latest = [
    ...new Map(
      listed.flat().flatMap((one) => (one.err === null ? [[one.signature, one] as const] : [])),
    ).values(),
  ]
    .toSorted((a, b) => b.slot - a.slot)
    .slice(0, MOVES);
  const read = await Promise.all(
    latest.map(({ signature }) => readTransfers("solana", signature, wallet)),
  );
  return read.flatMap(({ at, transfers }) =>
    transfers
      .filter((transfer) => transfer.instrument === mint)
      .map((transfer) => ({
        at,
        amount: formatUnits(transfer.baseUnits, transfer.decimals),
        who: transfer.counterparty && shortAddress(transfer.counterparty),
      })),
  );
}
