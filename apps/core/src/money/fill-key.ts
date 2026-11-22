import { coinToken, type EvmChainKey } from "@auni/shared";
import { inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { zeroAddress } from "viem";

/**
 * What a fill bought or sold, named the way the portfolio reads the holding
 * back. Execute records it, the pot and the permission gate weigh it, and
 * attribution matches it to a live holding, so every key is built by one of
 * the helpers below and compared through `fillIdentity`.
 */
export interface FillKey {
  readonly chain: FillChain;
  readonly instrument: string;
}

/** Every recorded quantity is weighed in these units, whatever the token's own decimals. */
export const QUANTITY_DECIMALS = 18;

/**
 * Where a holding is: a network (an EVM chain Auni doesn't know by name kept by its chain id), or
 * a ledger of an app's own, by the app's id (see ledgerAt in apps/registry.ts).
 */
export type FillChain = EvmChainKey | `eip155:${number}` | "solana" | (string & {});

/** The address wallets and aggregators use for a chain's own coin. */
export const EVM_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
/** Solana routes name SOL by its wrapped mint, but swaps unwrap it and the wallet holds plain SOL. */
export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

/**
 * An ERC-20 by address, or the chain's own coin as "native": by the address wallets and
 * aggregators name it by, the zero address some venues do, or its own token face where a chain
 * has one (Polygon's POL at 0x...1010), which is the coin, not a second holding of it.
 */
export function evmTokenKey(chain: EvmChainKey | `eip155:${number}`, token: string): FillKey {
  const native = [EVM_NATIVE.toLowerCase(), zeroAddress, coinToken(chain)].includes(
    token.toLowerCase(),
  );
  return { chain, instrument: native ? "native" : token };
}

/** A Solana token by mint; SOL itself is "native". */
export function solanaMintKey(mint: string): FillKey {
  return { chain: "solana", instrument: mint === WRAPPED_SOL ? "native" : mint };
}

/** A token as a move's details name it: by chain, and its address or mint. */
export function tokenKey(chain: string, token: string): FillKey {
  return chain === "solana" ? solanaMintKey(token) : evmTokenKey(chain as EvmChainKey, token);
}

/** One string per holding: EVM addresses arrive checksummed or not, so case never matters. */
export function fillIdentity(key: { readonly chain: string; readonly instrument: string }): string {
  return `${key.chain}:${key.instrument}`.toLowerCase();
}

/**
 * Whether an instrument `column` names one of these, as fillIdentity tells
 * them apart: a table may keep a token's case (a Solana mint's in
 * other_tokens), so case never matters here either.
 */
export function instrumentIn(column: AnyColumn, instruments: readonly string[]): SQL {
  return inArray(
    sql`lower(${column})`,
    instruments.map((instrument) => instrument.toLowerCase()),
  );
}
