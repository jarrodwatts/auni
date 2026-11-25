import {
  EVM_CASH_KEYS,
  EVM_CHAIN_KEYS,
  isEvmChain,
  NETWORKS,
  WITHDRAW_NETWORKS,
  type EvmCashKey,
  type WithdrawNetwork,
  withArticle,
} from "@auni/shared";
import { isAddress as isSolanaAddress, address as solanaAddress } from "@solana/kit";
import { and, desc, eq, sql } from "drizzle-orm";
import { erc20Abi, getAddress, isAddress as isEvmAddress, type Address } from "viem";
import { z } from "zod";

import { db } from "../db/client.ts";
import { actions } from "../db/schema.ts";
import { chainCash, savingsTokens } from "../apps/registry.ts";
import {
  publicClient,
  SOLANA_USDC,
  solanaRpc,
  solanaTokenBalance,
  SPL_TOKEN_PROGRAMS,
} from "./chains.ts";
import { sameDestination } from "./effect.ts";
import { burns } from "./gone-for-good.ts";
import type { FundingChain } from "./recipe.ts";
import { centsToUsd } from "./usd.ts";
import { walletAddresses } from "./wallets.ts";

/** The tool name, shared by the recipe and what reads back its moves. */
export const WITHDRAW_TOOL = "withdraw_usdc";

/**
 * Token contracts people paste by mistake: USDC itself on every network, and the other dollar
 * tokens Auni holds, which are every account's (the token savings are held as, the tokens a
 * chain's cash is held as). Sending USDC to one loses it.
 */
function tokenContracts(): Set<string> {
  return new Set(
    [
      ...EVM_CHAIN_KEYS.flatMap((key) => NETWORKS[key].usdc ?? []),
      ...EVM_CHAIN_KEYS.flatMap((key) => savingsTokens(key).map(({ token }) => token)),
      ...chainCash().flatMap(({ cash }) => cash.tokens),
    ].map((token) => token.toLowerCase()),
  );
}
const SOLANA_PROGRAMS = new Set([
  NETWORKS.solana.usdc,
  "11111111111111111111111111111111",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  ...SPL_TOKEN_PROGRAMS,
]);

/** Why a withdrawal to a burn address is refused: the owner reads it, and so does the agent. */
const BURNS =
  "That's a burn address: nobody can ever spend from it, so money sent there is gone for good. Use a real one.";

/**
 * The destination as it will be sent to, or a plain sentence saying why not:
 * checksummed on EVM networks (a mixed-case address must match its
 * checksum), a 32-byte base58 key on Solana. Never a burn address
 * (gone-for-good.ts), a token contract or the owner's own Auni wallet.
 */
export function destinationAddress(
  network: WithdrawNetwork,
  raw: string,
  own: { readonly evm: string | null; readonly solana: string | null },
): string {
  const value = raw.trim();
  if (isEvmChain(network)) {
    if (!isEvmAddress(value)) {
      throw new Error(
        /^0x[0-9a-fA-F]{40}$/u.test(value)
          ? "That address has a typo: its capital letters don't match. Copy it again."
          : `That isn't ${withArticle(NETWORKS[network].name)} address. It starts with 0x and has 42 characters.`,
      );
    }
    const checked = getAddress(value);
    if (burns(checked)) throw new Error(BURNS);
    if (tokenContracts().has(checked.toLowerCase()))
      throw new Error("That's a token's own address, not a wallet. Money sent there is lost.");
    if (own.evm && checked.toLowerCase() === own.evm.toLowerCase())
      throw new Error("That's your Auni wallet. Use the address of the place you're sending to.");
    return checked;
  }
  if (!isSolanaAddress(value)) throw new Error("That isn't a Solana address. Copy it again.");
  if (burns(value)) throw new Error(BURNS);
  if (SOLANA_PROGRAMS.has(value))
    throw new Error("That's a token or program address, not a wallet. Money sent there is lost.");
  if (own.solana && value === own.solana)
    throw new Error("That's your Auni wallet. Use the address of the place you're sending to.");
  return value;
}

/** Refuses a destination that is itself a token, read live from the network. */
export async function refuseTokenDestination(
  network: WithdrawNetwork,
  destination: string,
): Promise<void> {
  let token: boolean;
  try {
    token = await isToken(network, destination);
  } catch {
    throw new Error("That address couldn't be checked right now. Try again in a moment.");
  }
  if (token)
    throw new Error("That's a token's own address, not a wallet. Money sent there is lost.");
}

async function isToken(network: WithdrawNetwork, destination: string): Promise<boolean> {
  if (isEvmChain(network)) {
    const client = publicClient(network);
    const code = await client.getCode({ address: destination as Address });
    // Smart wallets have code too; only something that answers like a token is refused.
    if (!code || code === "0x") return false;
    const decimals = await client
      .readContract({ address: destination as Address, abi: erc20Abi, functionName: "decimals" })
      .catch(() => null);
    return decimals !== null;
  }
  const { value } = await solanaRpc<{
    value: { owner: string; executable: boolean } | null;
  }>("getAccountInfo", [destination, { encoding: "base64", commitment: "confirmed" }]);
  // A program, a mint or a token account: USDC sent "to" it lands where nobody can use it.
  // Ordinary wallets belong to the System Program and pass.
  return value !== null && (value.executable || SPL_TOKEN_PROGRAMS.includes(value.owner));
}

/**
 * A past destination this one could be mistaken for: same start and end,
 * different middle. Address poisoning plants exactly such a lookalike in a
 * person's history, hoping they copy it instead of the real one.
 */
export function lookalikeOf(destination: string, past: readonly string[]): string | null {
  const evm = destination.startsWith("0x");
  const norm = (value: string) => (evm ? value.toLowerCase() : value);
  // Four characters past EVM's 0x, which every EVM address shares.
  const head = (value: string) => norm(value).slice(0, evm ? 6 : 4);
  const tail = (value: string) => norm(value).slice(-4);
  return (
    past.find(
      (known) =>
        known.startsWith("0x") === evm &&
        !sameDestination(known, destination) &&
        head(known) === head(destination) &&
        tail(known) === tail(destination),
    ) ?? null
  );
}

/** Every destination money leaving the owner has already reached, whatever move sent it. */
export async function pastDestinations(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ to: sql<string>`${actions.details}->>'leavesTo'` })
    .from(actions)
    .where(and(eq(actions.status, "done"), sql`${actions.details} ? 'leavesTo'`));
  return rows.flatMap((row) => row.to?.split(",").filter(Boolean) ?? []);
}

/** A place the owner withdrew to, which Withdraw offers again: sent there before, it takes no proof. */
export interface RecentWithdrawal {
  readonly address: string;
  readonly network: WithdrawNetwork;
  readonly destination: "exchange" | "wallet" | null;
  /** When it last arrived there. */
  readonly at: Date;
}

/** How many past places Withdraw offers. */
const RECENT_PLACES = 4;

const sentInput = z.object({
  network: z.enum(WITHDRAW_NETWORKS),
  destination: z.enum(["exchange", "wallet"]).optional(),
});

/**
 * The places these finished withdrawals (newest first) went, newest first and each once: the
 * address it went to as sent (`leavesTo`), on its network. A row whose record doesn't say is
 * left out.
 */
export function recentPlaces(
  rows: readonly {
    readonly input: unknown;
    readonly details: Readonly<Record<string, string>>;
    readonly at: Date;
  }[],
): RecentWithdrawal[] {
  const places = new Map<string, RecentWithdrawal>();
  for (const { input, details, at } of rows) {
    const parsed = sentInput.safeParse(input);
    const address = details.leavesTo;
    if (!parsed.success || !address) continue;
    const { network, destination } = parsed.data;
    const key = `${network}:${address}`;
    if (!places.has(key))
      places.set(key, { address, network, destination: destination ?? null, at });
    if (places.size === RECENT_PLACES) break;
  }
  return [...places.values()];
}

/** Where the owner's last few withdrawals went (see recentPlaces). */
export async function recentWithdrawals(): Promise<RecentWithdrawal[]> {
  const rows = await db
    .select({ input: actions.input, details: actions.details, at: actions.updatedAt })
    .from(actions)
    .where(and(eq(actions.tool, WITHDRAW_TOOL), eq(actions.status, "done")))
    .orderBy(desc(actions.updatedAt))
    .limit(50);
  return recentPlaces(rows);
}

/** USDC resting in each of the owner's own wallets, in base units. Unreadable networks are left out. */
export async function walletUsdc(): Promise<Map<FundingChain, bigint>> {
  const wallets = await walletAddresses();
  const reads: [FundingChain, () => Promise<bigint>][] = [];
  const evm = wallets.evm as Address | null;
  if (evm) {
    for (const key of EVM_CASH_KEYS) {
      reads.push([
        key,
        () =>
          publicClient(key).readContract({
            address: NETWORKS[key].usdc,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [evm],
          }),
      ]);
    }
  }
  const solana = wallets.solana;
  if (solana) {
    reads.push([
      "solana",
      () => solanaTokenBalance(solanaAddress(solana), SOLANA_USDC.mint, SOLANA_USDC.tokenProgram),
    ]);
  }
  const settled = await Promise.allSettled(reads.map(([, read]) => read()));
  const balances = new Map<FundingChain, bigint>();
  settled.forEach((result, index) => {
    const chain = reads[index]?.[0];
    if (chain && result.status === "fulfilled") balances.set(chain, result.value);
  });
  return balances;
}

/**
 * The one wallet a withdrawal is paid from, all of it: the destination's own
 * network when it holds enough (a plain transfer), else the EVM wallet with
 * the most (bridged there). Null when no single wallet holds the amount.
 */
export function withdrawalSource(
  network: WithdrawNetwork,
  amount: bigint,
  balances: ReadonlyMap<FundingChain, bigint>,
): FundingChain | null {
  if ((balances.get(network) ?? 0n) >= amount) return network;
  let best: { chain: EvmCashKey; balance: bigint } | null = null;
  for (const chain of EVM_CASH_KEYS) {
    const balance = balances.get(chain) ?? 0n;
    if (chain !== network && balance >= amount && (!best || balance > best.balance))
      best = { chain, balance };
  }
  return best?.chain ?? null;
}

/** The most one withdrawal to `network` can send, by the same rule. */
export function maxWithdrawal(
  network: WithdrawNetwork,
  balances: ReadonlyMap<FundingChain, bigint>,
): bigint {
  let most = balances.get(network) ?? 0n;
  for (const chain of EVM_CASH_KEYS) {
    const balance = balances.get(chain) ?? 0n;
    if (chain !== network && balance > most) most = balance;
  }
  return most;
}

/** USDC base units as dollars, rounded down: never promise a cent the wallet doesn't hold. */
export function usdcToUsd(units: bigint): string {
  return centsToUsd(units / 10_000n);
}
