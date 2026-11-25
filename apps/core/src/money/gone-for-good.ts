import { isAddress } from "viem";

import type { ActionRow } from "../db/schema.ts";
import { approvedTokens } from "./approved.ts";
import { sameDestination } from "./effect.ts";
import { shortAddress } from "./format.ts";

// Addresses nobody can ever spend from, so money sent to one is gone for good. Every way money
// is sent to an address asks this one list: a withdrawal (and the bridge that carries one) refuses
// such a destination (withdrawals.ts), and a card that would send there says so on its face
// (action-card.ts), since a transaction the agent built may be meant to burn and is the one card
// that can do anything.

/**
 * The addresses money is sent to on purpose to burn it, on every EVM chain, lowercased. Nobody
 * holds their keys.
 */
const EVM_BURNS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
  "0xdead000000000000000000000000000000000000",
  "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
  "0xffffffffffffffffffffffffffffffffffffffff",
]);

/**
 * The precompiles every EVM chain has (0x01 to 0x11, and 0x100 where signatures are checked):
 * code with no key that keeps whatever coin it is sent. The other low addresses a chain keeps for
 * itself are left out, as some take coin to do something real: Monad's staking at 0x1000 takes
 * the MON it stakes, Arbitrum's ArbSys at 0x64 the ETH it carries home.
 */
function precompile(address: string): boolean {
  const at = BigInt(address);
  return (at >= 0x01n && at <= 0x11n) || at === 0x100n;
}

/** Solana's incinerator. Its programs, which keep what they are sent too, are refused as programs. */
const SOLANA_BURNS = new Set(["1nc1nerator11111111111111111111111111111111"]);

/** Whether nobody can ever spend from `address`, on any chain: what is sent there is burnt. */
export function burns(address: string): boolean {
  if (SOLANA_BURNS.has(address)) return true;
  if (!isAddress(address, { strict: false })) return false;
  return EVM_BURNS.has(address.toLowerCase()) || precompile(address);
}

/**
 * What a card says of money it sends where nobody can ever spend it, or null when it sends none
 * there: to a burn address, or to a token's own contract, which keeps what it is sent (`tokens`
 * are those the move sends).
 */
export function goneForGood(to: readonly string[], tokens: readonly string[] = []): string | null {
  const said = to.flatMap((address) => {
    if (burns(address))
      return [`${shortAddress(address)} is a burn address: nobody can ever spend from it.`];
    if (tokens.some((token) => sameDestination(token, address)))
      return [`${shortAddress(address)} is the token's own contract, not a wallet.`];
    return [];
  });
  return said.length > 0 ? `${said.join(" ")} What this sends there is gone for good.` : null;
}

/** What a move's card says of money it sends for good, from where its action pinned money going. */
export function lostSaid(row: Pick<ActionRow, "details">): string | null {
  const to = row.details.leavesTo?.split(",").filter(Boolean) ?? [];
  return goneForGood(to, approvedTokens(row)?.sends);
}
