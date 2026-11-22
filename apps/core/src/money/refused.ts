import type { FailureKind } from "@auni/shared";
import { decodeErrorResult, type Abi, type Hex } from "viem";

import type { Problems } from "../apps/contract.ts";
import { MayHaveSent } from "./recipe.ts";

/**
 * Thrown for a refusal an app knows (see Problems in apps/contract.ts): its message is the
 * app's own sentence for the owner, and `kind` is why the move stopped, which failureKind reads
 * before it guesses from the words.
 */
export class Refused extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind, say: string) {
    super(say);
    this.kind = kind;
  }
}

/**
 * The error to throw for what a service said as it refused: the first of the app's problems
 * that knows `message`, in the owner's words, or else the service's own words under the app's
 * `name` ("<Name> refused: <message>"), which failureKind then reads as any other message.
 */
export function refused(name: string, problems: Problems, message: string): Error {
  const known = problems.known.find(({ when }) => when.test(message));
  return known ? new Refused(known.kind, known.say) : new Error(`${name} refused: ${message}`);
}

/**
 * The bytes a contract reverted with, wherever an error carries them: a node's answer to the
 * estimate a wallet makes before it signs (local-key's send), or a simulation's
 * (simulateEffect, which keeps it as its cause). An app reads them with its `problems.said`.
 * Undefined when the error holds none, and always for a send that may have gone (MayHaveSent),
 * whatever it wraps: once a node may have taken the transaction, a receipt, not a revert, says
 * what became of it, so it is never read as a refusal.
 */
export function revertOf(error: unknown): Hex | undefined {
  let at: unknown = error;
  for (let depth = 0; depth < 8 && typeof at === "object" && at !== null; depth += 1) {
    if (at instanceof MayHaveSent) return undefined;
    for (const bytes of [(at as { raw?: unknown }).raw, (at as { data?: unknown }).data])
      if (typeof bytes === "string" && /^0x[0-9a-f]{8}/iu.test(bytes)) return bytes as Hex;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * What revert bytes say, read with a contract's `errors`: the error's name ("SupplyCapExceeded"),
 * a token's own words for a plain revert ("ERC20: transfer amount exceeds balance"), or a panic by
 * its code ("panic 0x11"). Bytes none of them reads are named by their selector.
 */
export function revertWords(data: Hex, errors: Abi): string {
  try {
    const { errorName, args } = decodeErrorResult({ abi: errors, data });
    // viem reads Solidity's own Error(string) and Panic(uint256) beside the contract's errors.
    const name: string = errorName;
    if (name === "Error") return String(args?.[0]);
    if (name === "Panic") return `panic 0x${(args?.[0] as bigint).toString(16)}`;
    return name;
  } catch {
    return `an error Auni can't read (${data.slice(0, 10)})`;
  }
}
